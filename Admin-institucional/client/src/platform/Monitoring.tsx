import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertTriangle, Check, CircleAlert, ExternalLink, Loader2, RefreshCw, Server, ShieldAlert } from 'lucide-react'
import { ApiError, api, errorMessage, formatDate, webLink, type Operation } from './api'
import './deployments.css'

interface AlertEpisode {
  alert: string; tenant: string | null; role: string | null; severity: string | null; target: string | null
  detectedAt: string; resolvedAt: string | null; active: boolean
}
interface TenantHealth { tenant: string; vms: { role: string; up: boolean }[]; web: boolean | null; api: boolean | null }
interface MonitoringData {
  configured: boolean; reachable?: boolean; message?: string; grafanaUrl?: string; checkedAt?: string
  tenants?: TenantHealth[]; alerts?: AlertEpisode[]
  events: { id: string; operation: Operation; status: string; at: string; slug: string; by: string }[]
  collectors: { name: string; where: string; purpose: string }[]
}

const alertText: Record<string, string> = {
  ServicioCaido: 'Servicio caído', WebOApiCaida: 'Web o API sin respuesta', LatenciaAlta: 'Latencia alta',
  ErroresDelBackend: 'Errores del backend', CPUAlta: 'CPU alta', MemoriaAlta: 'Memoria alta', DiscoLleno: 'Disco casi lleno',
}
const opText: Record<Operation, string> = { crear: 'Despliegue', suspender: 'Suspensión', reanudar: 'Reanudación', 'destruir-plan': 'Revisión de eliminación', destruir: 'Eliminación' }

const Dot = ({ ok }: { ok: boolean | null }) => ok === null
  ? <span className="dp-badge dp-st-sin-desplegar">sin datos</span>
  : <span className={`dp-badge ${ok ? 'dp-ok' : 'dp-st-error'}`}>{ok ? 'En línea' : 'Caído'}</span>

export default function Monitoring({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [data, setData] = useState<MonitoringData | null>(null)
  const [error, setError] = useState('')
  const fail = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, 'No se pudo cargar el monitoreo.'))
  }, [onSessionExpired])
  const load = useCallback(() => api<MonitoringData>('/api/platform/monitoring').then(result => { setData(result); setError('') }).catch(fail), [fail])

  useEffect(() => {
    let active = true
    const tick = () => api<MonitoringData>('/api/platform/monitoring').then(result => { if (active) { setData(result); setError('') } }).catch(cause => { if (active) fail(cause) })
    tick()
    const timer = window.setInterval(tick, 15000)
    return () => { active = false; window.clearInterval(timer) }
  }, [fail])

  const alerts = data?.alerts ?? []
  const firing = alerts.filter(item => item.active)
  const grafana = webLink(data?.grafanaUrl ? `${data.grafanaUrl}/d/capa8-tenants` : undefined)

  return <div className="dp">
    <section className="pa-card dp-card" aria-labelledby="mo-health">
      <header className="dp-head"><h2 id="mo-health"><Activity size={18} aria-hidden="true" /> Salud de las instituciones</h2>
        <span className="dp-actions">
          {grafana && <a className="pa-secondary" href={grafana} target="_blank" rel="noreferrer">Abrir Grafana <ExternalLink size={13} aria-hidden="true" /></a>}
          <button type="button" className="pa-secondary" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button>
        </span></header>
      {error && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {!data && !error && <div className="dp-muted" role="status"><Loader2 size={15} className="dp-spin" /> Cargando…</div>}
      {data && !data.configured && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> Configura <code>PLATFORM_GRAFANA_URL</code> en el servidor para ver el monitoreo.</div>}
      {data?.configured && data.reachable === false && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {data.message}</div>}
      {data?.reachable && <>
        <p className="dp-muted">Actualizado {data.checkedAt ? formatDate(data.checkedAt) : ''} · se refresca cada 15 s · {firing.length === 0 ? 'sin alertas activas' : `${firing.length} alerta(s) activa(s)`}</p>
        {(data.tenants ?? []).length === 0 && <div className="pa-empty"><Server size={24} /><p>Todavía no hay instituciones con métricas. Despliega una desde Despliegues.</p></div>}
        {(data.tenants ?? []).length > 0 && <div className="dp-table" role="table" aria-label="Salud por institución">
          <div className="dp-row dp-th mo-row" role="row"><span>Institución</span><span>Web</span><span>API</span><span>Máquinas</span></div>
          {data.tenants!.map(item => <div className="dp-row mo-row" role="row" key={item.tenant} data-tenant={item.tenant}>
            <span><strong>{item.tenant}</strong></span><span><Dot ok={item.web} /></span><span><Dot ok={item.api} /></span>
            <span className="dp-actions">{['frontend', 'backend', 'db'].map(role => { const vm = item.vms.find(entry => entry.role === role); return <span key={role} className={`dp-badge ${vm?.up ? 'dp-ok' : 'dp-st-error'}`}>{role} {vm?.up ? '✓' : '✕'}</span> })}</span>
          </div>)}
        </div>}
      </>}
    </section>

    {data?.reachable && <section className="pa-card dp-card" aria-labelledby="mo-alerts">
      <header className="dp-head"><h2 id="mo-alerts"><ShieldAlert size={18} aria-hidden="true" /> Alertas recientes (últimas 6 h)</h2></header>
      {alerts.length === 0 ? <div className="pa-empty"><Check size={24} /><p>No hubo alertas en las últimas 6 horas.</p></div>
        : <div className="dp-table" role="table" aria-label="Alertas">
          <div className="dp-row dp-th mo-alert" role="row"><span>Alerta</span><span>Institución afectada</span><span>Detectada</span><span>Estado</span></div>
          {alerts.map(item => <div className="dp-row mo-alert" role="row" key={`${item.alert}${item.target}${item.detectedAt}`}>
            <span><strong>{alertText[item.alert] ?? item.alert}</strong><small>{item.role ? `Rol ${item.role} · ` : ''}{item.target}</small></span>
            <span>{item.tenant ?? '—'}</span>
            <span>{formatDate(item.detectedAt)}</span>
            <span>{item.active ? <span className="dp-badge dp-st-error"><CircleAlert size={12} aria-hidden="true" /> Activa</span> : <span className="dp-badge dp-ok"><Check size={12} aria-hidden="true" /> Resuelta {item.resolvedAt ? formatDate(item.resolvedAt) : ''}</span>}</span>
          </div>)}
        </div>}
    </section>}

    {data && <section className="pa-card dp-card" aria-labelledby="mo-events">
      <header className="dp-head"><h2 id="mo-events"><Activity size={18} aria-hidden="true" /> Eventos recientes</h2></header>
      {data.events.length === 0 ? <p className="dp-muted">Aún no hay eventos.</p> : <ul className="mo-events">
        {data.events.map(item => <li key={item.id}><span className="dp-muted">{formatDate(item.at)}</span> <strong>{opText[item.operation]}</strong> de <code>{item.slug}</code> · {item.status === 'succeeded' ? 'completado' : item.status === 'failed' ? 'falló' : 'en curso'} · por {item.by}</li>)}
      </ul>}
    </section>}

    {data && <section className="pa-card dp-card mo-collectors" aria-labelledby="mo-col">
      <header className="dp-head"><h2 id="mo-col">En el servidor (recolectan)</h2></header>
      <ul>{data.collectors.map(item => <li key={item.name}><strong>{item.name}</strong> · {item.purpose}<small>{item.where}</small></li>)}</ul>
    </section>}
  </div>
}

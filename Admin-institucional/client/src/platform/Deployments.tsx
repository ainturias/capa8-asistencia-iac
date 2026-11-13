import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Activity, AlertTriangle, Check, CirclePause, CirclePlay, Clock3, ExternalLink, History, KeyRound, Loader2, RefreshCw,
  Rocket, RotateCcw, Search, ShieldCheck, Trash2, X,
} from 'lucide-react'
import {
  ApiError, api, errorMessage, formatDate, webLink,
  type DeployedTenant, type Job, type LifecycleStatus, type Operation, type Plan,
} from './api'
import './deployments.css'

const statusText: Record<LifecycleStatus, string> = {
  'sin-desplegar': 'Sin desplegar', aprovisionando: 'Aprovisionando…', activo: 'Activo', suspendido: 'Suspendido',
  eliminando: 'Eliminando…', eliminado: 'Eliminado', error: 'Con error',
}
const operationText: Record<Operation, string> = {
  crear: 'Desplegar', suspender: 'Suspender', reanudar: 'Reanudar', 'destruir-plan': 'Revisar eliminación', destruir: 'Eliminar',
}
const jobText = { queued: 'En cola', running: 'En curso', succeeded: 'Completado', failed: 'Fallido' } as const

type Allowed = Record<LifecycleStatus, Operation[]>
interface TenantsResponse { tenants: DeployedTenant[]; allowed: Allowed; grafanaUrl: string | null }

const busyJob = (job: Pick<Job, 'status'> | null | undefined) => job?.status === 'queued' || job?.status === 'running'
const duration = (job: Job) => {
  if (!job.startedAt) return '—'
  const seconds = Math.max(0, Math.round(((job.finishedAt ? new Date(job.finishedAt) : new Date()).getTime() - new Date(job.startedAt).getTime()) / 1000))
  return seconds >= 60 ? `${Math.floor(seconds / 60)} min ${seconds % 60} s` : `${seconds} s`
}

function JobStatusBadge({ status }: { status: Job['status'] }) {
  return <span className={`dp-badge dp-job-${status}`}>
    {status === 'running' || status === 'queued' ? <Loader2 size={12} className="dp-spin" aria-hidden="true" /> : status === 'succeeded' ? <Check size={12} aria-hidden="true" /> : <AlertTriangle size={12} aria-hidden="true" />}
    {jobText[status]}
  </span>
}

// Detalle de un trabajo: resultado, versiones (RF-13), escáneres, log y reintento (RF-12)
export function JobDetail({ jobId, onChanged, onSessionExpired }: { jobId: string; onChanged?: () => void; onSessionExpired: () => void }) {
  const [job, setJob] = useState<Job | null>(null)
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const logRef = useRef<HTMLPreElement>(null)
  const done = useRef(false)

  useEffect(() => {
    let active = true
    done.current = false
    const tick = () => api<{ job: Job }>(`/api/platform/jobs/${encodeURIComponent(jobId)}`).then(result => {
      if (!active) return
      setJob(result.job)
      if (!busyJob(result.job) && !done.current) { done.current = true; onChanged?.() }
    }).catch(cause => {
      if (!active) return
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
      else setError(errorMessage(cause, 'No se pudo cargar el trabajo.'))
    })
    tick()
    const timer = window.setInterval(() => { if (!done.current) tick() }, 2000)
    return () => { active = false; window.clearInterval(timer) }
  }, [jobId, onChanged, onSessionExpired])

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [job?.log])

  async function retry() {
    setRetrying(true)
    try {
      await api<{ id: string }>(`/api/platform/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: '{}' })
      onChanged?.()
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo reintentar.'))
    } finally { setRetrying(false) }
  }

  if (error) return <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {error}</div>
  if (!job) return <div className="dp-muted" role="status"><Loader2 size={15} className="dp-spin" /> Cargando trabajo…</div>
  const scans = job.scanSummary
  return <div className="dp-job" aria-label="Detalle del trabajo">
    <div className="dp-job-head">
      <strong>{operationText[job.operation]} · {job.institutionName}</strong>
      <JobStatusBadge status={job.status} />
      <span className="dp-muted">{formatDate(job.createdAt)} · por {job.requestedBy} · {duration(job)}</span>
    </div>
    {job.status === 'failed' && job.errorMessage && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> <span><b>Qué pasó:</b> {job.errorMessage}</span>
      {job.operation !== 'destruir' && <button type="button" className="dp-btn" disabled={retrying} onClick={() => void retry()}><RotateCcw size={14} /> {retrying ? 'Reintentando…' : 'Reintentar'}</button>}
    </div>}
    {job.retryOf && <p className="dp-muted">Reintento de un trabajo anterior. Reintentar no duplica recursos: solo se crea lo que falta.</p>}
    {scans && <div className="dp-scans" aria-label="Escáneres de seguridad"><ShieldCheck size={15} aria-hidden="true" /> <b>Seguridad (antes de aprovisionar):</b>
      {scans.escaneres.map(scan => <span key={scan.nombre} className={`dp-badge ${scan.hallazgos > 0 ? 'dp-warn' : 'dp-ok'}`}>{scan.nombre}: {scan.hallazgos} hallazgo{scan.hallazgos === 1 ? '' : 's'}</span>)}
      <span className="dp-muted">{scans.bloquea ? 'Se detectaron secretos.' : 'Informativo: no bloquea el despliegue.'}</span>
    </div>}
    {job.versions && <dl className="dp-versions" aria-label="Versiones usadas">
      <div><dt>Motor</dt><dd>{job.versions.engine?.version ?? job.versions.engine?.name ?? '—'}</dd></div>
      <div><dt>Ansible</dt><dd>{job.versions.ansible ?? '—'}</dd></div>
      <div><dt>Plantilla</dt><dd>{job.versions.moduleName} · {job.versions.moduleHash ?? '—'}</dd></div>
      <div><dt>Código</dt><dd>{job.versions.codeCommit ?? '—'}</dd></div>
      <div><dt>Imagen</dt><dd>{job.versions.imageId ?? '—'}</dd></div>
    </dl>}
    <pre className="dp-log" ref={logRef} aria-label="Registro de la operación" tabIndex={0}>{job.log || 'Esperando salida…'}</pre>
  </div>
}

function DeleteDialog({ tenant, onClose, onDone, onSessionExpired }: {
  tenant: DeployedTenant; onClose: () => void; onDone: () => void; onSessionExpired: () => void
}) {
  const [planJob, setPlanJob] = useState<string>()
  const [planLog, setPlanLog] = useState('')
  const [planState, setPlanState] = useState<Job['status']>('queued')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Debe lanzarse UNA sola vez: en desarrollo React ejecuta los efectos dos veces y se crearían dos trabajos.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    api<{ id: string }>(`/api/platform/tenants/${encodeURIComponent(tenant.slug)}/operations`, { method: 'POST', body: JSON.stringify({ operation: 'destruir-plan' }) })
      .then(result => setPlanJob(result.id))
      .catch(cause => {
        if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
        else setError(errorMessage(cause, 'No se pudo calcular qué se eliminará.'))
      })
  }, [tenant.slug, onSessionExpired])

  useEffect(() => {
    if (!planJob) return
    let active = true
    const timer = window.setInterval(async () => {
      try {
        const { job } = await api<{ job: Job }>(`/api/platform/jobs/${encodeURIComponent(planJob)}`)
        if (!active) return
        setPlanLog(job.log ?? '')
        setPlanState(job.status)
        if (!busyJob(job)) window.clearInterval(timer)
        if (job.status === 'failed') setError(job.errorMessage ?? 'No se pudo calcular qué se eliminará.')
      } catch { /* se reintenta en el siguiente ciclo */ }
    }, 1500)
    return () => { active = false; window.clearInterval(timer) }
  }, [planJob])

  const resources = planLog.split('\n').filter(line => /will be destroyed/.test(line)).map(line => line.replace(/^\s*#\s*/, '').replace(' will be destroyed', ''))
  const summary = planLog.split('\n').find(line => /^\s*Plan:/.test(line))

  async function remove() {
    setBusy(true)
    setError('')
    try {
      await api<{ id: string }>(`/api/platform/tenants/${encodeURIComponent(tenant.slug)}/operations`, { method: 'POST', body: JSON.stringify({ operation: 'destruir', confirm }) })
      onDone()
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo eliminar.'))
      setBusy(false)
    }
  }

  const ready = planState === 'succeeded'
  return <div className="dp-overlay" role="presentation">
    <div className="dp-dialog" role="dialog" aria-modal="true" aria-labelledby="dp-del-title">
      <header><h2 id="dp-del-title"><Trash2 size={18} /> Eliminar {tenant.institutionName}</h2>
        <button type="button" className="dp-icon" aria-label="Cerrar" onClick={onClose}><X size={18} /></button></header>
      <p>Se <b>borrarán definitivamente</b> estos recursos y los datos de la institución (base de datos incluida). Esta acción no se puede deshacer.</p>
      {!ready && !error && <div className="dp-muted" role="status"><Loader2 size={15} className="dp-spin" /> Calculando qué se eliminará…</div>}
      {ready && <>
        <ul className="dp-resources" aria-label="Recursos que se eliminarán">{resources.map(resource => <li key={resource}>{resource}</li>)}</ul>
        {summary && <p className="dp-muted">{summary.trim()}</p>}
        <label className="dp-confirm">Para confirmar escribe <code>{tenant.slug}</code>
          <input value={confirm} onChange={event => setConfirm(event.target.value)} autoComplete="off" aria-label="Confirmación del identificador" /></label>
      </>}
      {error && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {error}</div>}
      <footer>
        <button type="button" className="dp-btn" onClick={onClose}>Cancelar</button>
        <button type="button" className="dp-btn dp-danger" disabled={!ready || confirm !== tenant.slug || busy} onClick={() => void remove()}>
          <Trash2 size={14} /> {busy ? 'Eliminando…' : 'Eliminar definitivamente'}</button>
      </footer>
    </div>
  </div>
}

export default function Deployments({ plans, onSessionExpired }: { plans: Plan[]; onSessionExpired: () => void }) {
  const [data, setData] = useState<TenantsResponse | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [status, setStatus] = useState('')
  const [plan, setPlan] = useState('')
  const [environment, setEnvironment] = useState('')
  const [selected, setSelected] = useState<string>()
  const [jobId, setJobId] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [deleting, setDeleting] = useState<DeployedTenant>()
  const [creds, setCreds] = useState<{ slug: string; email: string; password: string }>()
  const [actionError, setActionError] = useState('')

  const query = useCallback(() => {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (status) params.set('status', status)
    if (plan) params.set('plan', plan)
    if (environment) params.set('environment', environment)
    return api<TenantsResponse>(`/api/platform/tenants?${params}`)
  }, [q, status, plan, environment])
  const onLoadError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, 'No se pudo cargar la lista de instituciones.'))
  }, [onSessionExpired])
  const load = useCallback(() => query().then(result => { setData(result); setError('') }).catch(onLoadError), [query, onLoadError])

  useEffect(() => {
    let active = true
    query().then(result => { if (active) { setData(result); setError('') } }).catch(cause => { if (active) onLoadError(cause) })
    return () => { active = false }
  }, [query, onLoadError])
  const transient = data?.tenants.some(tenant => tenant.lifecycleStatus === 'aprovisionando' || tenant.lifecycleStatus === 'eliminando')
  useEffect(() => {
    if (!transient) return
    const timer = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(timer)
  }, [transient, load])

  async function run(tenant: DeployedTenant, operation: Operation) {
    setBusy(`${tenant.slug}:${operation}`)
    setActionError('')
    try {
      const result = await api<{ id: string }>(`/api/platform/tenants/${encodeURIComponent(tenant.slug)}/operations`, { method: 'POST', body: JSON.stringify({ operation }) })
      setSelected(tenant.slug)
      setJobId(result.id)
      await load()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
      else setActionError(errorMessage(cause, 'No se pudo iniciar la operación.'))
    } finally { setBusy(undefined) }
  }

  async function showCredentials(tenant: DeployedTenant) {
    setActionError('')
    try {
      setCreds({ slug: tenant.slug, ...await api<{ email: string; password: string }>(`/api/platform/tenants/${encodeURIComponent(tenant.slug)}/credentials`) })
    } catch (cause) { setActionError(errorMessage(cause, 'No se pudieron obtener las credenciales.')) }
  }

  const sel = data?.tenants.find(tenant => tenant.slug === selected)
  const grafana = (tenant: DeployedTenant) => data?.grafanaUrl ? webLink(`${data.grafanaUrl.replace(/\/$/, '')}/d/capa8-tenants?var-tenant=${encodeURIComponent(tenant.slug)}`) : undefined

  return <div className="dp">
    <section className="pa-card dp-card" aria-labelledby="dp-title">
      <header className="dp-head"><h2 id="dp-title"><Rocket size={18} aria-hidden="true" /> Instituciones y despliegues</h2>
        <button type="button" className="pa-secondary" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button></header>
      <div className="dp-filters">
        <div className="pa-search"><Search size={17} /><input type="search" aria-label="Buscar por nombre" placeholder="Buscar por nombre…" value={q} onChange={event => setQ(event.target.value)} /></div>
        <select aria-label="Filtrar por estado" value={status} onChange={event => setStatus(event.target.value)}>
          <option value="">Todos los estados</option>{(Object.keys(statusText) as LifecycleStatus[]).map(key => <option key={key} value={key}>{statusText[key]}</option>)}</select>
        <select aria-label="Filtrar por plan" value={plan} onChange={event => setPlan(event.target.value)}>
          <option value="">Todos los planes</option>{plans.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        <select aria-label="Filtrar por entorno" value={environment} onChange={event => setEnvironment(event.target.value)}>
          <option value="">Todos los entornos</option><option value="production">Producción</option><option value="staging">Pruebas</option></select>
      </div>
      {error && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {actionError && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {actionError}</div>}
      {!data && !error && <div className="dp-muted" role="status"><Loader2 size={15} className="dp-spin" /> Cargando…</div>}
      {data && data.tenants.length === 0 && <div className="pa-empty"><Rocket size={24} /><p>No hay instituciones registradas con esos filtros. Registra una desde Solicitudes.</p></div>}
      {data && data.tenants.length > 0 && <div className="dp-table" role="table" aria-label="Instituciones">
        <div className="dp-row dp-th" role="row"><span role="columnheader">Institución</span><span role="columnheader">Plan</span><span role="columnheader">Motor</span><span role="columnheader">Entorno</span><span role="columnheader">Estado</span><span role="columnheader">Acciones</span></div>
        {data.tenants.map(tenant => {
          const ops = data.allowed[tenant.lifecycleStatus]
          const isBusy = Boolean(busy?.startsWith(`${tenant.slug}:`))
          const url = webLink(tenant.deployedUrl ?? undefined)
          const mon = grafana(tenant)
          return <div className={`dp-row${selected === tenant.slug ? ' dp-selected' : ''}`} role="row" key={tenant.id} data-tenant={tenant.slug}>
            <span role="cell"><button type="button" className="dp-link" onClick={() => { setSelected(tenant.slug); setJobId(tenant.lastJob?.id) }}><strong>{tenant.institutionName}</strong></button>
              <small>{tenant.slug}{url && <> · <a href={url} target="_blank" rel="noreferrer">Abrir app <ExternalLink size={11} aria-hidden="true" /></a></>}{mon && tenant.lifecycleStatus !== 'sin-desplegar' && <> · <a href={mon} target="_blank" rel="noreferrer">Grafana <Activity size={11} aria-hidden="true" /></a></>}</small></span>
            <span role="cell">{tenant.planName}</span>
            <span role="cell">{tenant.engine}</span>
            <span role="cell">{tenant.environment === 'production' ? 'Producción' : 'Pruebas'}</span>
            <span role="cell"><span className={`dp-badge dp-st-${tenant.lifecycleStatus}`}>{(tenant.lifecycleStatus === 'aprovisionando' || tenant.lifecycleStatus === 'eliminando') && <Loader2 size={12} className="dp-spin" aria-hidden="true" />}{statusText[tenant.lifecycleStatus]}</span></span>
            <span role="cell" className="dp-actions">
              {ops.includes('crear') && <button type="button" className="dp-btn dp-primary" disabled={isBusy} onClick={() => void run(tenant, 'crear')}><Rocket size={14} /> {tenant.lifecycleStatus === 'error' ? 'Reintentar despliegue' : tenant.lifecycleStatus === 'activo' ? 'Reconciliar' : 'Desplegar'}</button>}
              {ops.includes('suspender') && <button type="button" className="dp-btn" disabled={isBusy} onClick={() => void run(tenant, 'suspender')}><CirclePause size={14} /> Suspender</button>}
              {ops.includes('reanudar') && <button type="button" className="dp-btn" disabled={isBusy} onClick={() => void run(tenant, 'reanudar')}><CirclePlay size={14} /> Reanudar</button>}
              {(tenant.lifecycleStatus === 'activo' || tenant.lifecycleStatus === 'suspendido') && <button type="button" className="dp-btn" onClick={() => void showCredentials(tenant)}><KeyRound size={14} /> Credenciales</button>}
              {ops.includes('destruir') && <button type="button" className="dp-btn dp-danger" disabled={isBusy} onClick={() => setDeleting(tenant)}><Trash2 size={14} /> Eliminar</button>}
              {ops.length === 0 && <span className="dp-muted"><Clock3 size={13} /> En curso…</span>}
            </span>
          </div>
        })}
      </div>}
      {data && !data.grafanaUrl && <p className="dp-muted">Configura <code>PLATFORM_GRAFANA_URL</code> en el servidor para ver el enlace a Grafana de cada institución.</p>}
    </section>

    {creds && <section className="pa-card dp-card" aria-label="Credenciales del administrador">
      <header className="dp-head"><h2><KeyRound size={18} /> Acceso del administrador de {creds.slug}</h2><button type="button" className="dp-icon" aria-label="Ocultar credenciales" onClick={() => setCreds(undefined)}><X size={18} /></button></header>
      <p>Entrégalas al administrador de la institución por un canal seguro. Cámbialas tras el primer ingreso.</p>
      <dl className="dp-versions"><div><dt>Correo</dt><dd>{creds.email}</dd></div><div><dt>Contraseña</dt><dd><code>{creds.password}</code></dd></div></dl>
    </section>}

    {sel && <section className="pa-card dp-card" aria-label={`Operaciones de ${sel.institutionName}`}>
      <header className="dp-head"><h2><History size={18} /> Operaciones de {sel.institutionName}</h2></header>
      {jobId ? <JobDetail key={jobId} jobId={jobId} onChanged={() => void load()} onSessionExpired={onSessionExpired} /> : <p className="dp-muted">Esta institución todavía no tiene operaciones.</p>}
    </section>}

    {deleting && <DeleteDialog tenant={deleting} onSessionExpired={onSessionExpired} onClose={() => { setDeleting(undefined); void load() }}
      onDone={() => { setDeleting(undefined); void load() }} />}
  </div>
}

// Auditoría real: quién inició cada operación, cuándo y con qué resultado
export function JobsHistory({ onSessionExpired }: { onSessionExpired: () => void }) {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string>()
  const onLoadError = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
    else setError(errorMessage(cause, 'No se pudo cargar el historial.'))
  }, [onSessionExpired])
  const load = useCallback(() => api<{ jobs: Job[] }>('/api/platform/jobs').then(result => { setJobs(result.jobs); setError('') }).catch(onLoadError), [onLoadError])
  useEffect(() => {
    let active = true
    api<{ jobs: Job[] }>('/api/platform/jobs').then(result => { if (active) { setJobs(result.jobs); setError('') } }).catch(cause => { if (active) onLoadError(cause) })
    return () => { active = false }
  }, [onLoadError])
  const running = jobs?.some(job => busyJob(job))
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(timer)
  }, [running, load])

  return <div className="dp">
    <section className="pa-card dp-card" aria-labelledby="dp-hist">
      <header className="dp-head"><h2 id="dp-hist"><History size={18} /> Historial de operaciones</h2>
        <button type="button" className="pa-secondary" onClick={() => void load()}><RefreshCw size={15} /> Actualizar</button></header>
      {error && <div className="dp-alert" role="alert"><AlertTriangle size={16} /> {error}</div>}
      {!jobs && !error && <div className="dp-muted" role="status"><Loader2 size={15} className="dp-spin" /> Cargando…</div>}
      {jobs && jobs.length === 0 && <div className="pa-empty"><History size={24} /><p>Todavía no hay operaciones.</p></div>}
      {jobs && jobs.length > 0 && <div className="dp-table dp-hist" role="table" aria-label="Operaciones">
        <div className="dp-row dp-th" role="row"><span role="columnheader">Cuándo</span><span role="columnheader">Institución</span><span role="columnheader">Operación</span><span role="columnheader">Quién</span><span role="columnheader">Resultado</span></div>
        {jobs.map(job => <div key={job.id} role="row" className="dp-hist-item">
          <button type="button" className="dp-row dp-rowbtn" aria-expanded={open === job.id} onClick={() => setOpen(open === job.id ? undefined : job.id)}>
            <span>{formatDate(job.createdAt)}</span><span><strong>{job.institutionName}</strong><small>{job.slug} · {job.engine}</small></span>
            <span>{operationText[job.operation]}</span><span>{job.requestedBy}</span><span><JobStatusBadge status={job.status} /></span>
          </button>
          {open === job.id && <JobDetail key={job.id} jobId={job.id} onChanged={() => void load()} onSessionExpired={onSessionExpired} />}
        </div>)}
      </div>}
    </section>
  </div>
}

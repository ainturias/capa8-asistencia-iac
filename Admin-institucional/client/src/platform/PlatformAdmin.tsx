import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type FormEvent } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import {
  Activity, ArrowLeft, ArrowRight, Building2, Check, ChevronRight, CircleAlert, ClipboardList, Clock3,
  Database, ExternalLink, Eye, EyeOff, Globe2, GraduationCap, History, House, Layers3, Link2, LockKeyhole, LogOut, Mail, Menu, Monitor,
  Plus, RefreshCw, Rocket, Search, Server, Settings2, ShieldCheck, X,
} from 'lucide-react'
import {
  ApiError, api, attendanceLoginLink, errorMessage, formatDate, formatNumber, webLink,
  type InvitationStatus, type Plan, type PlatformUser, type TenantConfiguration, type TenantRequest,
} from './api'
import CreatePlanDialog from './CreatePlanDialog'
import CreateTenantDialog, { type TenantPreview } from './CreateTenantDialog'
import Deployments, { JobsHistory } from './Deployments'
import PlatformHome from './PlatformHome'
import PlatformMonitoring from './PlatformMonitoring'
import PlatformSettings from './PlatformSettings'
import { engines, environments, optionLabel, providers, regions, slugFromName, type Provider } from './tenant-options'
import './admin.css'

type Filter = 'all' | 'pending' | 'registered'

const navigation = [
  { id: 'home', group: 'platform', label: 'Inicio', title: 'Inicio', description: 'Consulta las solicitudes, instituciones y planes de la plataforma.', Icon: House },
  { id: 'requests', group: 'platform', label: 'Solicitudes', title: 'Solicitudes de instituciones', description: 'Revisa las solicitudes y configura el registro de cada institución.', Icon: ClipboardList },
  { id: 'tenants', group: 'platform', label: 'Instituciones', title: 'Instituciones registradas', description: 'Consulta el plan y la configuración de cada institución registrada.', Icon: Building2 },
  { id: 'deployments', group: 'platform', label: 'Despliegues', title: 'Despliegues', description: 'Despliega, suspende, reanuda o elimina la infraestructura de cada institución y revisa su progreso.', Icon: Rocket },
  { id: 'plans', group: 'platform', label: 'Planes', title: 'Catálogo de planes', description: 'Consulta la capacidad y los recursos que incluye cada plan.', Icon: Layers3 },
  { id: 'monitoring', group: 'platform', label: 'Monitoreo', title: 'Monitoreo', description: 'Consulta el estado de los servicios y el uso de recursos por institución.', Icon: Activity },
  { id: 'audit', group: 'platform', label: 'Auditoría', title: 'Auditoría', description: 'Consulta quién realizó cada acción, cuándo y con qué resultado.', Icon: History },
  { id: 'settings', group: 'admin', label: 'Configuración', title: 'Configuración', description: 'Gestiona las preferencias generales de la plataforma.', Icon: Settings2 },
] as const
type View = (typeof navigation)[number]['id']

const menuGroups = [
  { id: 'platform', label: 'Plataforma' },
  { id: 'admin', label: 'Administración' },
] as const

const demoViews: Partial<Record<View, ComponentType>> = {
  monitoring: PlatformMonitoring,
  settings: PlatformSettings,
}

function Brand() {
  return <div className="pa-brand">
    <span className="pa-brand-mark"><GraduationCap size={23} strokeWidth={2} /></span>
    <span><strong>Asistencia</strong><small>Plataforma</small></span>
  </div>
}

function ErrorNotice({ children }: { children: string }) {
  return <div className="pa-error" role="alert"><CircleAlert size={17} /><span>{children}</span></div>
}

function Login({ onLogin }: { onLogin: (user: PlatformUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await api<{ user: PlatformUser }>('/api/platform/session', {
        method: 'POST', body: JSON.stringify({ email: email.trim(), password }),
      })
      onLogin(result.user)
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo iniciar sesión. Intenta de nuevo.'))
    } finally {
      setBusy(false)
    }
  }

  return <main className="pa-login">
    <div className="pa-login-shell">
      <section className="pa-login-story">
        <Brand />
        <div className="pa-login-story-content">
          <span className="pa-login-story-icon"><Building2 size={30} strokeWidth={1.65} /></span>
          <h1>Gestiona tus instituciones desde un solo lugar.</h1>
          <p>Revisa solicitudes, consulta los planes y registra instituciones en la plataforma de asistencia.</p>
        </div>
        <Link to="/" className="pa-login-back"><ArrowLeft size={16} /> Volver al inicio</Link>
      </section>
      <section className="pa-login-form" aria-labelledby="pa-login-title">
        <div className="pa-login-form-inner">
          <span className="pa-icon-tile"><LockKeyhole size={23} /></span>
          <h2 id="pa-login-title">Iniciar sesión</h2>
          <p>Acceso para administradores de la plataforma.</p>
          <form onSubmit={submit}>
            <label htmlFor="pa-email">Correo electrónico</label>
            <input id="pa-email" type="email" autoComplete="username" placeholder="admin@ejemplo.com" value={email} onChange={event => setEmail(event.target.value)} required />
            <label htmlFor="pa-password">Contraseña</label>
            <div className="pa-password-field">
              <input id="pa-password" type={passwordVisible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
              <button type="button" aria-label={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'} onClick={() => setPasswordVisible(!passwordVisible)}>
                {passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <button className="pa-primary" type="submit" disabled={busy}>
              {busy ? 'Ingresando…' : 'Entrar a la plataforma'} <ArrowRight size={17} />
            </button>
          </form>
        </div>
      </section>
    </div>
  </main>
}

function Status({ value }: { value: TenantRequest['status'] }) {
  return <span className={`pa-status pa-status-${value}`}>
    {value === 'pending' ? <Clock3 size={13} /> : <Check size={13} />}
    {value === 'pending' ? 'Pendiente' : 'Registrada'}
  </span>
}

const instanceRoles = {
  frontend: { label: 'Frontend', Icon: Monitor },
  backend: { label: 'Backend', Icon: Server },
  database: { label: 'Base de datos', Icon: Database },
}

function PlanInstances({ plan, provider }: { plan: Plan; provider?: Provider }) {
  return <section className="pa-plan-instances" aria-label="Instancias de referencia">
    <h3>Instancias de referencia</h3>
    {plan.instances?.length ? <ul className="pa-instance-list">
      {plan.instances.map(instance => {
        const { label, Icon } = instanceRoles[instance.role]
        return <li className="pa-instance" key={instance.role}>
          <span className="pa-instance-icon"><Icon size={15} aria-hidden="true" /></span>
          <div>
            <strong>{label}</strong>
            <div className="pa-instance-size">{formatNumber(instance.vcpu)} vCPU · {formatNumber(instance.ramGib)} GiB RAM</div>
            <div className="pa-instance-size">Disco del sistema · {formatNumber(instance.systemDiskGb)} GB</div>
            <div className="pa-instance-models">
              {provider !== 'azure' && <span>AWS <code>{instance.awsType}</code></span>}
              {provider !== 'aws' && <span>Azure <code>{instance.azureType}</code></span>}
            </div>
          </div>
        </li>
      })}
    </ul> : <p className="pa-instance-empty">El catálogo todavía no informa el tamaño de las instancias.</p>}
  </section>
}

function PlanResourceRows({ plan }: { plan: Plan }) {
  return <>
    <div><dt><GraduationCap size={15} /> Capacidad</dt><dd>{formatNumber(plan.limitStudents)} estudiantes</dd></div>
    <div><dt><Database size={15} /> Disco de datos PostgreSQL</dt><dd>{formatNumber(plan.databaseGb)} GB</dd></div>
    <div><dt><ShieldCheck size={15} /> Respaldo</dt><dd>{plan.backup}</dd></div>
  </>
}

const invitationDetails = {
  pending: { label: 'Invitación pendiente', text: 'La instalación está vinculada y la invitación está pendiente.', Icon: Clock3 },
  sent: { label: 'Invitación enviada', text: 'El administrador puede activar su cuenta desde el enlace del correo.', Icon: Mail },
  failed: { label: 'Envío fallido', text: 'La instalación está vinculada. Puedes volver a enviar la invitación.', Icon: CircleAlert },
  activated: { label: 'Cuenta activada', text: 'El administrador ya puede iniciar sesión en la aplicación de asistencia.', Icon: Check },
  preview: { label: 'Invitación en vista previa', text: 'El entorno de desarrollo generó una vista previa de la invitación.', Icon: Mail },
} satisfies Record<InvitationStatus, { label: string; text: string; Icon: typeof Mail }>

function Installation({ requestId, tenant, onUpdated, onSessionExpired }: {
  requestId: string
  tenant: TenantConfiguration
  onUpdated: (request: TenantRequest) => void
  onSessionExpired: () => void
}) {
  const [appUrl, setAppUrl] = useState('')
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [resending, setResending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const installationUrl = attendanceLoginLink(tenant.appUrl)
  const status = tenant.invitationStatus
  const details = status && (status !== 'pending' || installationUrl) ? invitationDetails[status] : undefined
  const canReplace = status === 'sent' || status === 'preview'
  const showForm = status !== 'activated' && (!canReplace || resending)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const bootstrapField = form.elements.namedItem('bootstrapKey') as HTMLInputElement
    const body = JSON.stringify({ appUrl: (tenant.appUrl ?? appUrl).trim(), bootstrapKey: bootstrapField.value.trim() })
    bootstrapField.value = ''
    setBusy(true)
    setError('')
    try {
      const result = await api<{ request: TenantRequest; previewUrl?: string }>(`/api/platform/requests/${encodeURIComponent(requestId)}/invitation`, { method: 'POST', body })
      onUpdated(result.request)
      setPreviewUrl(result.request.tenant?.invitationStatus === 'preview' ? webLink(result.previewUrl) : undefined)
      setResending(false)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) onSessionExpired()
      else if (cause instanceof ApiError && cause.status === 502) setError(cause.message)
      else setError(errorMessage(cause, 'No se pudo vincular la instalación o preparar la invitación. Intenta de nuevo.'))
    } finally {
      setBusy(false)
    }
  }

  return <section className="pa-installation" aria-labelledby="pa-installation-title">
    <div className="pa-installation-heading"><span className="pa-icon-tile"><Link2 size={19} /></span><div>
      <h3 id="pa-installation-title">{installationUrl ? 'Instalación vinculada' : 'Vincular instalación'}</h3>
      <p>{installationUrl ? 'Acceso del administrador de la institución.' : 'Conecta una instalación de asistencia ya desplegada y envía la invitación al contacto de la institución.'}</p>
    </div></div>
    {details && <div className={`pa-invite-status pa-invite-status-${status}`} role="status">
      <details.Icon size={17} />
      <div><strong>{details.label}</strong><p>{details.text}</p>
        {tenant.invitationUpdatedAt && <time dateTime={tenant.invitationUpdatedAt}>{formatDate(tenant.invitationUpdatedAt)}</time>}
      </div>
    </div>}
    {installationUrl && <a className="pa-installation-link" href={installationUrl} target="_blank" rel="noreferrer">Abrir aplicación de asistencia <ExternalLink size={14} /></a>}
    {previewUrl && status === 'preview' && !busy && <a className="pa-preview-link" href={previewUrl} target="_blank" rel="noreferrer">Abrir invitación de prueba <ExternalLink size={14} /><small>Vista previa de desarrollo</small></a>}
    {canReplace && !resending && <div className="pa-invite-actions">
      <button className="pa-secondary" type="button" onClick={() => setResending(true)}><Mail size={15} /> Reenviar invitación</button>
    </div>}
    {showForm && <form className="pa-register-form pa-invitation-form" autoComplete="off" onSubmit={submit}>
      <label htmlFor="pa-app-url">URL de la aplicación</label>
      <input id="pa-app-url" type="url" placeholder="https://asistencia.institucion.edu" value={tenant.appUrl ?? appUrl} onChange={event => setAppUrl(event.target.value)} aria-describedby="pa-app-url-help" spellCheck={false} readOnly={Boolean(tenant.appUrl)} required />
      <small id="pa-app-url-help">Ingresa la URL base de la instalación.</small>
      <label htmlFor="pa-bootstrap-key">Clave de vinculación</label>
      <input id="pa-bootstrap-key" name="bootstrapKey" type="password" autoComplete="new-password" aria-describedby="pa-bootstrap-help" required />
      <small id="pa-bootstrap-help">Usa la clave de vinculación de esta instalación.</small>
      {resending && <p className="pa-replace-note">Al reenviar la invitación se reemplaza el enlace anterior.</p>}
      {error && <ErrorNotice>{error}</ErrorNotice>}
      <div className="pa-invite-actions">
        <button className="pa-primary" type="submit" disabled={busy}>
          {busy ? 'Procesando…' : installationUrl ? 'Reenviar invitación' : 'Vincular y enviar invitación'} <ArrowRight size={16} />
        </button>
        {resending && <button className="pa-secondary" type="button" disabled={busy} onClick={() => { setResending(false); setError('') }}>Cancelar</button>}
      </div>
    </form>}
  </section>
}

function RequestDetail({ request, plan, onRegistered, onInvitationUpdated, onSessionExpired }: {
  request: TenantRequest
  plan: Plan | undefined
  onRegistered: (request: TenantRequest) => void
  onInvitationUpdated: (request: TenantRequest) => void
  onSessionExpired: () => void
}) {
  const [slug, setSlug] = useState(() => slugFromName(request.institutionName))
  const [region, setRegion] = useState(regions[0].value)
  const [environment, setEnvironment] = useState(environments[0].value)
  const [engine, setEngine] = useState(engines[0].value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const provider = regions.find(option => option.value === (request.tenant?.region ?? region))?.provider

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await api<{ request: TenantRequest }>(`/api/platform/requests/${encodeURIComponent(request.id)}/register`, {
        method: 'POST', body: JSON.stringify({ slug: slug.trim(), region, environment, engine }),
      })
      onRegistered(result.request)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionExpired()
        return
      }
      setError(errorMessage(cause, 'No se pudo registrar la institución. Intenta de nuevo.'))
    } finally {
      setBusy(false)
    }
  }

  return <article className="pa-card pa-detail" aria-labelledby="pa-detail-title">
    <header className="pa-detail-head">
      <span className="pa-icon-tile"><Building2 size={23} /></span>
      <div><p>Solicitud de institución</p><h2 id="pa-detail-title">{request.institutionName}</h2></div>
      <Status value={request.status} />
    </header>
    <div className="pa-detail-grid">
      <div className="pa-detail-main">
        <section aria-labelledby="pa-contact-title" className="pa-contact">
          <h3 id="pa-contact-title">Contacto de la institución</h3>
          <dl><div><dt>Administrador</dt><dd>{request.adminName}</dd></div>
            <div><dt>Correo electrónico</dt><dd>{request.adminEmail}</dd></div></dl>
        </section>
        {request.status === 'registered' ? <section className="pa-registered" aria-labelledby="pa-registered-title">
          <div className="pa-confirmed"><Check size={17} /> Institución registrada</div>
          <h3 id="pa-registered-title">Configuración registrada</h3>
          {request.tenant && <dl>
            <div><dt>Identificador</dt><dd>{request.tenant.slug}</dd></div>
            <div><dt>Región</dt><dd>{optionLabel(regions, request.tenant.region)}</dd></div>
            <div><dt>Entorno</dt><dd>{optionLabel(environments, request.tenant.environment)}</dd></div>
            <div><dt>Motor</dt><dd>{optionLabel(engines, request.tenant.engine)}</dd></div>
          </dl>}
          {request.tenant && <Installation requestId={request.id} tenant={request.tenant} onUpdated={onInvitationUpdated} onSessionExpired={onSessionExpired} />}
        </section> : <form className="pa-register-form" onSubmit={register} aria-labelledby="pa-register-title">
          <h3 id="pa-register-title">Configurar institución</h3>
          <label htmlFor="pa-slug">Identificador único</label>
          <input id="pa-slug" aria-describedby="pa-slug-help" value={slug} onChange={event => setSlug(event.target.value.toLowerCase())} pattern="[a-z0-9]+(?:\x2d[a-z0-9]+)*" minLength={3} maxLength={63} autoComplete="off" required />
          <small id="pa-slug-help">De 3 a 63 caracteres. Usa minúsculas, números y guiones entre palabras.</small>
          <div className="pa-form-grid">
            <div><label htmlFor="pa-region">Región</label><select id="pa-region" value={region} onChange={event => setRegion(event.target.value)}>
              {regions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></div>
            <div><label htmlFor="pa-environment">Entorno</label><select id="pa-environment" value={environment} onChange={event => setEnvironment(event.target.value)}>
              {environments.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></div>
          </div>
          <label htmlFor="pa-engine">Motor de infraestructura</label>
          <select id="pa-engine" value={engine} onChange={event => setEngine(event.target.value)}>
            {engines.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {error && <ErrorNotice>{error}</ErrorNotice>}
          <button type="submit" className="pa-primary" disabled={busy}>
            {busy ? 'Registrando…' : 'Registrar institución'} <ArrowRight size={16} />
          </button>
        </form>}
      </div>
      <aside className="pa-summary">
        <h3>Resumen</h3>
        <dl>
          <div><dt>Plan solicitado</dt><dd><span className="pa-plan-tag">{plan?.name ?? request.planId}</span></dd></div>
          <div><dt>Fecha de solicitud</dt><dd>{formatDate(request.createdAt)}</dd></div>
          {plan && <PlanResourceRows plan={plan} />}
        </dl>
        {plan && <PlanInstances plan={plan} provider={provider} />}
        <p><Server size={16} /> El registro guarda la configuración para el aprovisionamiento.</p>
      </aside>
    </div>
  </article>
}

function TenantPreviewDetail({ draft, plan }: { draft: TenantPreview; plan: Plan | undefined }) {
  return <article className="pa-card pa-detail" aria-labelledby="pa-preview-title">
    <header className="pa-detail-head">
      <span className="pa-icon-tile"><Building2 size={23} aria-hidden="true" /></span>
      <div><h2 id="pa-preview-title">{draft.institutionName}</h2></div>
      <span className="pa-status pa-status-preview"><Eye size={13} aria-hidden="true" /> Vista previa</span>
    </header>
    <div className="pa-detail-grid">
      <div className="pa-detail-main">
        <section aria-labelledby="pa-preview-contact" className="pa-contact">
          <h3 id="pa-preview-contact">Contacto de la institución</h3>
          <dl>
            <div><dt>Administrador</dt><dd>{draft.adminName}</dd></div>
            <div><dt>Correo electrónico</dt><dd>{draft.adminEmail}</dd></div>
          </dl>
        </section>
        <section className="pa-registered" aria-labelledby="pa-preview-config">
          <h3 id="pa-preview-config">Configuración prevista</h3>
          <dl>
            <div><dt>Identificador</dt><dd>{draft.slug}</dd></div>
            <div><dt>Proveedor</dt><dd>{optionLabel(providers, draft.provider)}</dd></div>
            <div><dt>Región</dt><dd>{optionLabel(regions, draft.region)}</dd></div>
            <div><dt>Entorno</dt><dd>{optionLabel(environments, draft.environment)}</dd></div>
            <div><dt>Motor</dt><dd>{optionLabel(engines, draft.engine)}</dd></div>
          </dl>
        </section>
        <p className="pa-preview-note">Configuración temporal para revisar el despliegue antes de registrar la institución.</p>
      </div>
      <aside className="pa-summary">
        <h3>Resumen del plan</h3>
        <dl>
          <div><dt>Plan elegido</dt><dd><span className="pa-plan-tag">{plan?.name ?? draft.planId}</span></dd></div>
          {plan && <PlanResourceRows plan={plan} />}
        </dl>
        {plan && <PlanInstances plan={plan} provider={draft.provider} />}
      </aside>
    </div>
  </article>
}

function Console({ user, onLogout }: { user: PlatformUser; onLogout: () => void }) {
  const [view, setView] = useState<View>('home')
  const pageHeading = useRef<HTMLHeadingElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  const restoreDialogFocus = useRef<HTMLButtonElement | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string>()
  const [requests, setRequests] = useState<TenantRequest[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [logoutBusy, setLogoutBusy] = useState(false)
  const [logoutError, setLogoutError] = useState('')
  const [notice, setNotice] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [createPlanOpen, setCreatePlanOpen] = useState(false)
  const [createTenantOpen, setCreateTenantOpen] = useState(false)
  const [tenantPreviews, setTenantPreviews] = useState<TenantPreview[]>([])

  useEffect(() => {
    let active = true
    Promise.all([
      api<{ requests: TenantRequest[] }>('/api/platform/requests'),
      api<{ plans: Plan[] }>('/api/plans'),
    ]).then(([requestResult, planResult]) => {
      if (!active) return
      setRequests(requestResult.requests)
      setPlans(planResult.plans)
    }).catch(cause => {
      if (!active) return
      if (cause instanceof ApiError && cause.status === 401) onLogout()
      else setError(errorMessage(cause, 'No se pudo cargar el panel.'))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [onLogout, revision])

  const pending = requests.filter(request => request.status === 'pending').length
  const registered = requests.length - pending
  const visibleRequests = useMemo(() => {
    const search = query.trim().toLocaleLowerCase('es')
    return requests.filter(request => {
      const status = view === 'tenants' ? 'registered' : filter
      const matchesStatus = status === 'all' || request.status === status
      const searchable = [request.institutionName, request.adminName, request.adminEmail, request.tenant?.slug].join(' ').toLocaleLowerCase('es')
      return matchesStatus && searchable.includes(search)
    })
  }, [requests, query, view, filter])
  const visiblePreviews = view === 'tenants' ? tenantPreviews.filter(draft =>
    [draft.institutionName, draft.adminName, draft.adminEmail, draft.slug].join(' ').toLocaleLowerCase('es')
      .includes(query.trim().toLocaleLowerCase('es')),
  ) : []
  const selectedPreview = visiblePreviews.find(draft => `preview:${draft.slug}` === selectedId)
    ?? (visibleRequests.length === 0 ? visiblePreviews[0] : undefined)
  const selected = selectedPreview ? undefined : visibleRequests.find(request => request.id === selectedId) ?? visibleRequests[0]
  const selectedPlan = plans.find(plan => plan.id === (selectedPreview ?? selected)?.planId)
  const activeNav = navigation.find(item => item.id === view)!
  const DemoView = demoViews[view]
  const initials = user.name.trim().split(/\s+/).slice(0, 2).map(name => name[0]).join('').toUpperCase()

  function changeView(next: View) {
    setView(next)
    setQuery('')
    setSelectedId(undefined)
    setMenuOpen(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
    requestAnimationFrame(() => pageHeading.current?.focus({ preventScroll: true }))
  }

  function showRequests(status: Filter, requestId?: string) {
    changeView('requests')
    setFilter(status)
    setSelectedId(requestId)
  }

  function onRegistered(request: TenantRequest) {
    onInvitationUpdated(request)
    setFilter('all')
    setSelectedId(request.id)
    setNotice(`${request.institutionName} se registró correctamente.`)
  }

  function onInvitationUpdated(request: TenantRequest) {
    setRequests(previous => previous.map(item => item.id === request.id ? request : item))
  }

  function onPlanCreated(plan: Plan) {
    setPlans(previous => [...previous.filter(item => item.id !== plan.id), plan]
      .sort((left, right) => left.limitStudents - right.limitStudents || left.id.localeCompare(right.id)))
    setCreatePlanOpen(false)
    setNotice(`«${plan.name}» ya está disponible en el catálogo.`)
  }

  function onTenantPreview(draft: TenantPreview) {
    setTenantPreviews(previous => [draft, ...previous])
    setCreateTenantOpen(false)
    restoreDialogFocus.current = null
    changeView('tenants')
    setSelectedId(`preview:${draft.slug}`)
    setNotice(`Vista previa de «${draft.institutionName}» creada.`)
  }

  function openTenantDialog() {
    restoreDialogFocus.current = menuOpen ? menuTrigger.current : null
    setMenuOpen(false)
    setCreateTenantOpen(true)
  }

  function closeTenantDialog() {
    setCreateTenantOpen(false)
    restoreDialogFocus.current?.focus()
    restoreDialogFocus.current = null
  }

  function refresh() {
    setError('')
    setLoading(true)
    setRevision(previous => previous + 1)
  }

  async function logout() {
    setLogoutBusy(true)
    setLogoutError('')
    try {
      await api<void>('/api/platform/session', { method: 'DELETE' })
      onLogout()
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onLogout()
        return
      }
      setLogoutError(errorMessage(cause, 'No se pudo cerrar sesión. Intenta de nuevo.'))
      setLogoutBusy(false)
    }
  }

  return <div className="pa-console" onKeyDown={event => { if (event.key === 'Escape') setMenuOpen(false) }}>
    <button type="button" aria-label="Cerrar menú" className={`pa-scrim${menuOpen ? ' pa-scrim-open' : ''}`} onClick={() => setMenuOpen(false)} tabIndex={menuOpen ? 0 : -1} />
    <aside id="pa-navigation" className={`pa-sidebar${menuOpen ? ' pa-sidebar-open' : ''}`}>
      <div className="pa-sidebar-brand"><Brand /><button type="button" className="pa-icon-button pa-menu-close" aria-label="Cerrar navegación" onClick={() => setMenuOpen(false)}><X size={19} /></button></div>
      <nav aria-label="Administración">
        {menuGroups.map(({ id: group, label: groupLabel }) => <div className="pa-nav-group" key={group}>
          <span className="pa-nav-label">{groupLabel}</span>
          {navigation.filter(item => item.group === group).map(({ id, label, Icon }) => <Fragment key={id}>
            <button type="button" aria-current={id === view ? 'page' : undefined} onClick={() => changeView(id)}>
              <Icon size={18} aria-hidden="true" /> {label}
              {id === 'requests' && pending > 0 && <span aria-label={`${pending} pendientes`}>{pending}</span>}
            </button>
            {id === 'tenants' && <button type="button" aria-haspopup="dialog" disabled={loading || Boolean(error)} onClick={openTenantDialog}>
              <Plus size={18} aria-hidden="true" /> Crear institución
            </button>}
          </Fragment>)}
        </div>)}
      </nav>
      <div className="pa-sidebar-foot">
        <div className="pa-profile"><span className="pa-avatar">{initials}</span><div><strong>{user.name}</strong><small>Administrador de plataforma</small></div></div>
        <button type="button" className="pa-logout" disabled={logoutBusy} onClick={() => void logout()}><LogOut size={17} /> {logoutBusy ? 'Cerrando sesión…' : 'Cerrar sesión'}</button>
      </div>
    </aside>
    <div className="pa-workspace">
      <header className="pa-topbar">
        <button ref={menuTrigger} type="button" className="pa-icon-button pa-menu-button" aria-label="Abrir menú" aria-controls="pa-navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={22} /></button>
        <span className="pa-breadcrumb">Plataforma <ChevronRight size={15} /> <strong>{activeNav.label}</strong></span>
        <Link to="/" className="pa-topbar-link"><Globe2 size={17} /> <span>Sitio público</span></Link>
      </header>
      <main className="pa-content">
        <header className="pa-page-head">
          <div>
            <h1 ref={pageHeading} tabIndex={-1}>{activeNav.title}</h1>
            <p>{activeNav.description}</p>
          </div>
          {view === 'plans'
            ? <button className="pa-primary pa-create-plan" type="button" disabled={loading} onClick={() => setCreatePlanOpen(true)}><Plus size={18} aria-hidden="true" /> Crear plan</button>
            : !DemoView && view !== 'deployments' && view !== 'audit' && <div className="pa-page-actions">
              <button className="pa-secondary pa-refresh" type="button" disabled={loading} onClick={refresh}><RefreshCw size={15} aria-hidden="true" /> Actualizar</button>
              {(view === 'home' || view === 'tenants') && <button className="pa-primary" type="button" aria-haspopup="dialog" disabled={loading || Boolean(error)} onClick={openTenantDialog}><Plus size={18} aria-hidden="true" /> Crear institución</button>}
            </div>}
        </header>
        {logoutError && <ErrorNotice>{logoutError}</ErrorNotice>}
        {notice && <div className="pa-notice" role="status"><Check size={18} /><span>{notice}</span><button type="button" aria-label="Cerrar aviso" onClick={() => setNotice('')}><X size={17} /></button></div>}
        {view === 'deployments' ? <Deployments plans={plans} onSessionExpired={onLogout} /> : view === 'audit' ? <JobsHistory onSessionExpired={onLogout} /> : DemoView ? <DemoView /> : loading ? <div className="pa-card pa-empty" role="status"><span className="pa-spinner" />Cargando el panel…</div> : error ? <div className="pa-card pa-load-error">
          <ErrorNotice>{error}</ErrorNotice>
          <button type="button" className="pa-secondary" onClick={refresh}>Volver a intentar</button>
        </div> : view === 'home' ? <PlatformHome requests={requests} plans={plans}
          onPending={() => showRequests('pending')} onRequests={() => showRequests('all')}
          onTenants={() => changeView('tenants')} onPlans={() => changeView('plans')}
          onRequest={id => showRequests('all', id)} /> : view === 'plans' ? <div className="pa-plans">
          {plans.map(plan => <article className="pa-card pa-plan-card" key={plan.id}><span className="pa-icon-tile"><Layers3 size={21} /></span><h2>{plan.name}</h2><p>{plan.description}</p>
            <dl><div><dt>Capacidad</dt><dd>{formatNumber(plan.limitStudents)} estudiantes</dd></div><div><dt>Disco de datos PostgreSQL</dt><dd>{formatNumber(plan.databaseGb)} GB</dd></div><div><dt>Respaldo</dt><dd>{plan.backup}</dd></div></dl>
            <PlanInstances plan={plan} />
          </article>)}
          {plans.length === 0 && <div className="pa-card pa-empty">El catálogo está vacío.</div>}
        </div> : <>
          {view === 'requests' && <div className="pa-stats" aria-label="Resumen de solicitudes">
            <div className="pa-card"><span className="pa-icon-tile"><ClipboardList size={20} /></span><div><p>Solicitudes totales</p><strong>{requests.length}</strong></div></div>
            <div className="pa-card"><span className="pa-icon-tile pa-icon-amber"><Clock3 size={20} /></span><div><p>Pendientes</p><strong>{pending}</strong></div></div>
            <div className="pa-card"><span className="pa-icon-tile pa-icon-green"><Check size={21} /></span><div><p>Registradas</p><strong>{registered}</strong></div></div>
          </div>}
          <div className="pa-console-grid">
            <section className="pa-card pa-list" aria-labelledby="pa-list-title">
              <header><h2 id="pa-list-title">{view === 'tenants' ? 'Instituciones' : 'Bandeja de solicitudes'}</h2><span>{visibleRequests.length}</span></header>
              <div className="pa-list-controls">
                <div className="pa-search"><Search size={17} /><input type="search" aria-label="Buscar institución" placeholder="Buscar institución…" value={query} onChange={event => setQuery(event.target.value)} /></div>
                {view === 'requests' && <select aria-label="Filtrar por estado" value={filter} onChange={event => setFilter(event.target.value as Filter)}>
                  <option value="all">Todos los estados</option><option value="pending">Pendientes</option><option value="registered">Registradas</option>
                </select>}
              </div>
              {visibleRequests.length > 0 ? <ul>
                {visibleRequests.map(request => <li key={request.id}>
                  <button type="button" aria-pressed={selected?.id === request.id} onClick={() => setSelectedId(request.id)}>
                    <span className="pa-row-text"><strong>{request.institutionName}</strong><small>{plans.find(plan => plan.id === request.planId)?.name ?? request.planId} · {formatDate(request.createdAt)}</small></span>
                    <ChevronRight size={16} />
                    <Status value={request.status} />
                  </button>
                </li>)}
              </ul> : visiblePreviews.length === 0 && <div className="pa-empty"><ClipboardList size={24} /><p>{query || (view === 'requests' && filter !== 'all') ? 'No hay resultados para los filtros.' : view === 'tenants' ? 'Todavía no hay instituciones registradas.' : 'Todavía no hay solicitudes.'}</p></div>}
              {visiblePreviews.length > 0 && <div className="pa-preview-list">
                <h3 id="pa-preview-list-title">Vistas previas</h3>
                <ul aria-labelledby="pa-preview-list-title">
                  {visiblePreviews.map(draft => <li key={draft.slug}>
                    <button type="button" aria-pressed={selectedPreview?.slug === draft.slug} onClick={() => setSelectedId(`preview:${draft.slug}`)}>
                      <span className="pa-row-text"><strong>{draft.institutionName}</strong><small>{plans.find(plan => plan.id === draft.planId)?.name ?? draft.planId} · {draft.slug}</small></span>
                      <ChevronRight size={16} aria-hidden="true" />
                      <span className="pa-status pa-status-preview">Vista previa</span>
                    </button>
                  </li>)}
                </ul>
              </div>}
            </section>
            {selectedPreview ? <TenantPreviewDetail draft={selectedPreview} plan={selectedPlan} />
              : selected ? <RequestDetail key={selected.id} request={selected} plan={selectedPlan} onRegistered={onRegistered} onInvitationUpdated={onInvitationUpdated} onSessionExpired={onLogout} /> : <section className="pa-card pa-empty pa-empty-detail"><span className="pa-icon-tile"><Building2 size={24} /></span><h2>Detalles de la institución</h2><p>Selecciona una institución para ver su información.</p></section>}
          </div>
        </>}
      </main>
    </div>
    {createPlanOpen && <CreatePlanDialog onClose={() => setCreatePlanOpen(false)} onCreated={onPlanCreated} onSessionExpired={onLogout} />}
    {createTenantOpen && <CreateTenantDialog plans={plans} onClose={closeTenantDialog} onPreview={onTenantPreview}
      usedSlugs={[...requests.flatMap(request => request.tenant ? [request.tenant.slug] : []), ...tenantPreviews.map(draft => draft.slug)]} />}
  </div>
}

export default function PlatformAdmin() {
  const location = useLocation()
  const [user, setUser] = useState<PlatformUser | null>(null)
  const [checking, setChecking] = useState(true)
  const clearSession = useCallback(() => setUser(null), [])
  const isLogin = location.pathname.replace(/\/$/, '') === '/plataforma/login'

  useEffect(() => {
    let active = true
    api<{ user: PlatformUser }>('/api/platform/session')
      .then(result => { if (active) setUser(result.user) })
      .catch(() => { if (active) setUser(null) })
      .finally(() => { if (active) setChecking(false) })
    return () => { active = false }
  }, [])

  if (checking) return <main className="pa-session-check" role="status"><Brand /><span className="pa-spinner" /> Verificando sesión…</main>
  if (user && isLogin) return <Navigate to="/plataforma" replace />
  if (!user && !isLogin) return <Navigate to="/plataforma/login" replace />
  return user ? <Console user={user} onLogout={clearSession} /> : <Login onLogin={setUser} />
}

export interface PlanInstance {
  role: 'frontend' | 'backend' | 'database'
  vcpu: number
  ramGib: number
  systemDiskGb: number
  awsType: string
  azureType: string
}

export interface Plan {
  id: string
  name: string
  description: string
  limitStudents: number
  databaseGb: number
  backup: string
  instances: PlanInstance[]
}

export type InvitationStatus = 'pending' | 'sent' | 'failed' | 'activated' | 'preview'

export interface InstallationStatus {
  appUrl?: string
  invitationStatus?: InvitationStatus
  invitationUpdatedAt?: string
}

export interface TenantConfiguration extends InstallationStatus {
  id: string
  slug: string
  region: string
  environment: string
  engine: string
  createdAt: string
}

export interface TrackedRequest {
  id: string
  institutionName: string
  planId: string
  status: 'pending' | 'registered'
  createdAt: string
  updatedAt: string
  tenant?: InstallationStatus
}

export interface TenantRequest extends TrackedRequest {
  adminName: string
  adminEmail: string
  tenant?: TenantConfiguration
}

export interface PlatformUser {
  name: string
  email: string
}

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('Accept', 'application/json')
  if (init?.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, { ...init, headers, credentials: 'same-origin' })
  if (response.status === 204) return undefined as T

  const isJson = response.headers.get('content-type')?.includes('application/json')
  if (!isJson) {
    throw new ApiError('El servicio de plataforma no está disponible. Inténtalo nuevamente.', response.status)
  }

  const data = await response.json()
  if (!response.ok) {
    throw new ApiError(typeof data.message === 'string' ? data.message : 'No se pudo completar la operación.', response.status)
  }
  return data as T
}

export const formatDate = (value: string) => new Intl.DateTimeFormat('es-BO', {
  dateStyle: 'medium',
  timeStyle: 'short',
}).format(new Date(value))

export const formatNumber = (value: number) => new Intl.NumberFormat('es-BO').format(value)

export function webLink(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) return url.href
  } catch {
    return undefined
  }
  return undefined
}

export function attendanceLoginLink(origin?: string) {
  const href = webLink(origin)
  return href ? new URL('/login', href).href : undefined
}

export const errorMessage = (error: unknown, fallback: string) => (
  error instanceof ApiError && error.status < 500 ? error.message : fallback
)

export type LifecycleStatus = 'sin-desplegar' | 'aprovisionando' | 'activo' | 'suspendido' | 'eliminando' | 'eliminado' | 'error'
export type Operation = 'crear' | 'suspender' | 'reanudar' | 'destruir-plan' | 'destruir'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export interface DeployedTenant {
  id: string
  slug: string
  institutionName: string
  adminEmail: string
  planId: string
  planName: string
  infraPlan: string | null
  environment: string
  engine: string
  region: string
  lifecycleStatus: LifecycleStatus
  lifecycleUpdatedAt: string
  deployedUrl: string | null
  lastJob: { id: string; operation: Operation; status: JobStatus; createdAt: string } | null
}

export interface JobVersions {
  engine?: { name: string; version: string | null }
  ansible?: string | null
  codeCommit?: string | null
  moduleHash?: string | null
  moduleName?: string
  imageId?: string
  infraPlan?: string
}

export interface ScanSummary {
  generado: string
  bloquea: boolean
  escaneres: { nombre: string; tipo: string; hallazgos: number; severidad?: Record<string, number> }[]
}

export interface Job {
  id: string
  operation: Operation
  engine: string
  plan: string | null
  status: JobStatus
  requestedBy: string
  retryOf: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  errorMessage: string | null
  versions: JobVersions | null
  scanSummary: ScanSummary | null
  slug: string
  institutionName: string
  log?: string
}

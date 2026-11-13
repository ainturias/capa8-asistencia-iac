-- Estado de ciclo de vida del tenant y URL desplegada
ALTER TABLE platform_tenants
    ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'sin-desplegar'
        CHECK (lifecycle_status IN ('sin-desplegar', 'aprovisionando', 'activo', 'suspendido', 'eliminando', 'eliminado', 'error')),
    ADD COLUMN deployed_url TEXT,
    ADD COLUMN lifecycle_updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Equivalencia entre el plan comercial y el plan del modulo de infraestructura (infra/modules/tenant)
ALTER TABLE platform_plans ADD COLUMN infra_plan TEXT CHECK (infra_plan IN ('basic', 'standard', 'advanced'));
UPDATE platform_plans SET infra_plan = 'basic'    WHERE id = 'basico';
UPDATE platform_plans SET infra_plan = 'standard' WHERE id = 'estandar';
UPDATE platform_plans SET infra_plan = 'advanced' WHERE id = 'avanzado';

-- Los tipos de maquina del catalogo deben coincidir con lo que el modulo realmente crea (docs/catalogo-de-planes.md)
UPDATE platform_plan_instances SET aws_type = 't3.micro',  vcpu = 2, ram_gib = 1, system_disk_gb = 10 WHERE plan_id = 'basico';
UPDATE platform_plan_instances SET aws_type = 't3.small',  vcpu = 2, ram_gib = 2, system_disk_gb = 20 WHERE plan_id = 'estandar';
UPDATE platform_plan_instances SET aws_type = 't3.medium', vcpu = 2, ram_gib = 4, system_disk_gb = 30 WHERE plan_id = 'avanzado';
UPDATE platform_plan_instances SET system_disk_gb = 50 WHERE plan_id = 'avanzado' AND role = 'database';
UPDATE platform_plans SET database_gb = 10 WHERE id = 'basico';
UPDATE platform_plans SET database_gb = 20 WHERE id = 'estandar';
UPDATE platform_plans SET database_gb = 50 WHERE id = 'avanzado';

-- Trabajos de aprovisionamiento: historial, resultado, versiones usadas (RF-13) y quien lo pidio (RF-20)
CREATE TABLE platform_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES platform_tenants(id),
    operation TEXT NOT NULL CHECK (operation IN ('crear', 'suspender', 'reanudar', 'destruir-plan', 'destruir')),
    engine TEXT NOT NULL,
    plan TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    requested_by TEXT NOT NULL,
    retry_of UUID REFERENCES platform_jobs(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    exit_code INTEGER,
    error_message TEXT,
    log TEXT NOT NULL DEFAULT '',
    versions JSONB,
    scan_summary JSONB
);

CREATE INDEX platform_jobs_tenant_idx ON platform_jobs (tenant_id, created_at DESC);
-- Un solo trabajo activo por tenant: evita dos apply a la vez sobre el mismo state
CREATE UNIQUE INDEX platform_jobs_one_active_per_tenant ON platform_jobs (tenant_id) WHERE status IN ('queued', 'running');

// Runner de aprovisionamiento: ejecuta infra/scripts/tenant.sh en segundo plano y guarda el historial.
// Requisitos del proyecto final que cubre: trabajos en segundo plano con estado consultable, log, errores sin
// secretos (RF-11), reintento sin duplicar recursos (RF-12), versiones usadas por despliegue (RF-13),
// quien inició cada operación (RF-20) y ciclo de vida del tenant (RF-14 a RF-18).
const { spawn, execFile } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { transaction } = require('./db');

class ProvisionerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const OPERATIONS = ['crear', 'suspender', 'reanudar', 'destruir-plan', 'destruir'];
// Qué operaciones permite cada estado del ciclo de vida
const ALLOWED = {
  'sin-desplegar': ['crear'],
  aprovisionando: [],
  eliminando: [],
  activo: ['crear', 'suspender', 'destruir-plan', 'destruir'],
  suspendido: ['reanudar', 'destruir-plan', 'destruir'],
  error: ['crear', 'destruir-plan', 'destruir'],
  eliminado: ['crear'],
};
const IMPLEMENTED_ENGINES = new Set(['opentofu', 'terraform']);
const LOG_LIMIT = 200_000;
const FLUSH_MS = 1500;
const JOB_TIMEOUT_MS = 25 * 60 * 1000;

function settings() {
  const root = path.resolve(process.env.PROVISIONER_ROOT || path.join(__dirname, '..', '..', '..', '..'));
  return {
    enabled: process.env.PROVISIONER_ENABLED !== 'false',
    root,
    script: process.env.PROVISIONER_SCRIPT || path.join(root, 'infra', 'scripts', 'tenant.sh'),
    amiId: process.env.PROVISIONER_AMI_ID?.trim() || '',
    region: process.env.PROVISIONER_REGION?.trim() || 'us-east-2',
    concurrency: Math.max(1, Number(process.env.PROVISIONER_CONCURRENCY ?? '2') || 2),
    grafanaUrl: process.env.PLATFORM_GRAFANA_URL?.trim() || '',
  };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Nunca mostrar secretos en el log ni en los errores (requisito no funcional)
const SECRET_PATTERNS = [
  [/(AKIA|ASIA)[0-9A-Z]{16}/g, '[clave-aws-oculta]'],
  // Nombres compuestos incluidos: AWS_SECRET_ACCESS_KEY, DB_PASSWORD, TF_ENCRYPTION, github_token...
  [/([\w.-]*(?:password|passwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|encryption|credential)[\w.-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[oculto]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[llave-privada-oculta]'],
  [/\b[0-9a-f]{40,}\b/gi, '[hex-oculto]'],
];

function clean(text) {
  let out = text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000, ...options }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim());
    });
  });
}

async function moduleHash(root) {
  try {
    const dir = path.join(root, 'infra', 'modules', 'tenant');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.tf')).sort();
    const hash = crypto.createHash('sha256');
    for (const file of files) hash.update(await fs.readFile(path.join(dir, file)));
    return hash.digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

// RF-13: versiones de la aplicación, las plantillas y las herramientas usadas en cada despliegue
async function collectVersions(cfg, engine, infraPlan) {
  const bin = engine === 'opentofu' ? 'tofu' : 'terraform';
  const [engineVersion, ansible, gitCommit, hash] = await Promise.all([
    runCapture(bin, ['version']),
    runCapture('ansible', ['--version']),
    runCapture('git', ['-C', cfg.root, 'rev-parse', '--short', 'HEAD']),
    moduleHash(cfg.root),
  ]);
  return {
    engine: { name: engine, version: engineVersion?.split('\n')[0] ?? null },
    ansible: ansible?.split('\n')[0] ?? null,
    codeCommit: gitCommit,
    moduleHash: hash,
    moduleName: 'infra/modules/tenant',
    imageId: cfg.amiId || 'ubuntu-22.04 (sin AMI de Packer)',
    infraPlan,
  };
}

async function readScanSummary(cfg, since) {
  try {
    const file = path.join(cfg.root, 'infra', 'scanners', 'reports', 'resumen.json');
    const stat = await fs.stat(file);
    if (stat.mtimeMs < since.getTime() - 2000) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function childEnv(adminEmail, cfg) {
  const env = { LANG: 'C.UTF-8', TENANT_ADMIN_EMAIL: adminEmail, TENANT_REGION: cfg.region };
  for (const [key, value] of Object.entries(process.env)) {
    // Lista blanca: nada de PLATFORM_*, DATABASE_URL ni contraseñas de la plataforma llega al proceso hijo
    if (/^(PATH|HOME|USER|SHELL|TMPDIR|TF_ENCRYPTION|AWS_.*|ANSIBLE_.*|PACKER_.*)$/.test(key) && value !== undefined) env[key] = value;
  }
  return env;
}

const jobColumns = `j.id, j.operation, j.engine, j.plan, j.status, j.requested_by AS "requestedBy", j.retry_of AS "retryOf",
         j.created_at AS "createdAt", j.started_at AS "startedAt", j.finished_at AS "finishedAt",
         j.exit_code AS "exitCode", j.error_message AS "errorMessage", j.versions, j.scan_summary AS "scanSummary",
         t.slug, r.institution_name AS "institutionName"`;
const jobFrom = `
  FROM platform_jobs j
  JOIN platform_tenants t ON t.id = j.tenant_id
  JOIN platform_requests r ON r.id = t.request_id
`;
const jobSelect = `SELECT ${jobColumns} ${jobFrom}`;

function createProvisioner(pool) {
  const queue = [];
  let active = 0;

  async function setLifecycle(client, tenantId, status, extra = {}) {
    const sets = ['lifecycle_status = $2', 'lifecycle_updated_at = now()'];
    const params = [tenantId, status];
    if ('deployedUrl' in extra) {
      params.push(extra.deployedUrl);
      sets.push(`deployed_url = $${params.length}`);
    }
    await client.query(`UPDATE platform_tenants SET ${sets.join(', ')} WHERE id = $1`, params);
  }

  async function execute(job) {
    const cfg = settings();
    const started = new Date();
    const { rows: [ctx] } = await pool.query(`
      SELECT t.id AS tenant_id, t.slug, t.engine, t.lifecycle_status, r.admin_email, p.infra_plan
      FROM platform_jobs j JOIN platform_tenants t ON t.id = j.tenant_id
      JOIN platform_requests r ON r.id = t.request_id JOIN platform_plans p ON p.id = r.plan_id
      WHERE j.id = $1`, [job.id]);
    const versions = await collectVersions(cfg, job.engine, ctx.infra_plan);
    await pool.query("UPDATE platform_jobs SET status = 'running', started_at = $2, versions = $3 WHERE id = $1",
      [job.id, started, JSON.stringify(versions)]);

    let log = `$ ${job.operation} ${ctx.slug} · motor=${job.engine} plan=${ctx.infra_plan}\n`;
    let dirty = true;
    let truncated = false;
    const append = (chunk) => {
      log += clean(chunk.toString('utf8'));
      if (log.length > LOG_LIMIT) {
        log = `${truncated ? '' : '[… log recortado: se muestra el final …]\n'}${log.slice(log.length - LOG_LIMIT)}`;
        truncated = true;
      }
      dirty = true;
    };
    const flush = async () => {
      if (!dirty) return;
      dirty = false;
      await pool.query('UPDATE platform_jobs SET log = $2 WHERE id = $1', [job.id, log]).catch(() => {});
    };
    const timer = setInterval(flush, FLUSH_MS);

    const exit = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('bash', [cfg.script, job.operation, job.engine, ctx.slug, ctx.infra_plan, cfg.amiId], {
          cwd: cfg.root, env: childEnv(ctx.admin_email, cfg), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        append(`No se pudo iniciar el proceso: ${error.message}\n`);
        return resolve({ code: 127, signal: null });
      }
      const kill = setTimeout(() => {
        append('\n[tiempo máximo excedido: se detiene el trabajo]\n');
        try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ya terminó */ }
      }, JOB_TIMEOUT_MS);
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.on('error', (error) => { append(`Error del proceso: ${error.message}\n`); });
      child.on('close', (code, signal) => { clearTimeout(kill); resolve({ code: code ?? 1, signal }); });
    });
    clearInterval(timer);

    const ok = exit.code === 0;
    const urlMatch = /^URL:\s*(https?:\/\/\S+)/m.exec(log);
    const scan = job.operation === 'crear' ? await readScanSummary(cfg, started) : null;
    const message = ok ? null : friendlyError(log, exit);
    await transaction(pool, async (client) => {
      await client.query(`
        UPDATE platform_jobs SET status = $2, finished_at = now(), exit_code = $3, error_message = $4, log = $5, scan_summary = $6
        WHERE id = $1`, [job.id, ok ? 'succeeded' : 'failed', exit.code, message, log, scan ? JSON.stringify(scan) : null]);
      if (ok) {
        if (job.operation === 'crear') await setLifecycle(client, ctx.tenant_id, 'activo', { deployedUrl: urlMatch?.[1] ?? null });
        if (job.operation === 'reanudar') await setLifecycle(client, ctx.tenant_id, 'activo');
        if (job.operation === 'suspender') await setLifecycle(client, ctx.tenant_id, 'suspendido');
        if (job.operation === 'destruir') await setLifecycle(client, ctx.tenant_id, 'eliminado', { deployedUrl: null });
        if (job.operation === 'destruir-plan') await setLifecycle(client, ctx.tenant_id, job.previousStatus);
      } else {
        await setLifecycle(client, ctx.tenant_id, job.operation === 'crear' || job.operation === 'destruir' ? 'error' : job.previousStatus);
      }
    });
  }

  // RF-11: error comprensible, sin secretos ni volcado de la salida completa
  function friendlyError(log, exit) {
    const text = log.slice(-6000);
    const rules = [
      [/UnauthorizedOperation|AccessDenied|not authorized/i, 'AWS rechazó la operación por permisos insuficientes del usuario IAM.'],
      [/InstanceLimitExceeded|VcpuLimitExceeded|LimitExceeded/i, 'AWS alcanzó un límite de cuota (instancias o vCPU). Libera recursos o pide un aumento de cuota.'],
      [/ExpiredToken|InvalidClientTokenId|AuthFailure|credentials/i, 'Las credenciales de AWS no son válidas o expiraron.'],
      [/Error acquiring the state lock|state lock/i, 'El estado está bloqueado por otra operación en curso. Espera a que termine y reintenta.'],
      [/UNREACHABLE|Timeout \(\d+s\) waiting for privilege|wait_for_connection/i, 'Ansible no pudo conectarse por SSH a las máquinas. Reintenta en unos minutos.'],
      [/failed=[1-9]|fatal: \[/i, 'Ansible falló al configurar una de las máquinas. Revisa el log para ver la tarea.'],
      [/No se encontr|not found|command not found/i, 'Falta una herramienta en el servidor de la plataforma (revisa el log).'],
      [/Backend initialization|NoSuchBucket|backend/i, 'No se pudo acceder al estado remoto (bucket S3). Revisa permisos y configuración.'],
    ];
    for (const [pattern, message] of rules) if (pattern.test(text)) return message;
    if (exit.signal) return `El trabajo se detuvo (${exit.signal}).`;
    return `La operación terminó con error (código ${exit.code}). Revisa el log.`;
  }

  async function pump() {
    const cfg = settings();
    while (active < cfg.concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      execute(job)
        .catch(async (error) => {
          console.error('Fallo interno del runner.', error.code ?? error.name);
          await pool.query("UPDATE platform_jobs SET status = 'failed', finished_at = now(), error_message = $2 WHERE id = $1 AND status <> 'succeeded'",
            [job.id, 'Error interno del runner de aprovisionamiento.']).catch(() => {});
          await pool.query("UPDATE platform_tenants SET lifecycle_status = $2 WHERE id = $1", [job.tenantId, job.previousStatus]).catch(() => {});
        })
        .finally(() => { active -= 1; pump(); });
    }
  }

  async function enqueue(slug, operation, user, options = {}) {
    const cfg = settings();
    if (!cfg.enabled) throw new ProvisionerError(503, 'El aprovisionamiento está deshabilitado en esta plataforma.');
    if (!OPERATIONS.includes(operation)) throw new ProvisionerError(400, 'Operación no válida.');
    try {
      const job = await transaction(pool, async (client) => {
        const { rows: [t] } = await client.query(`
          SELECT t.id, t.slug, t.engine, t.region, t.lifecycle_status, p.infra_plan, p.name AS plan_name
          FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id JOIN platform_plans p ON p.id = r.plan_id
          WHERE t.slug = $1 FOR UPDATE OF t`, [slug]);
        if (!t) throw new ProvisionerError(404, 'Tenant no encontrado.');
        if (!ALLOWED[t.lifecycle_status].includes(operation)) {
          throw new ProvisionerError(409, `No se puede ${operation} un tenant en estado "${t.lifecycle_status}".`);
        }
        if (!IMPLEMENTED_ENGINES.has(t.engine)) {
          throw new ProvisionerError(422, `El motor "${t.engine}" todavía no está integrado en esta plataforma. Usa OpenTofu o Terraform.`);
        }
        if (!t.infra_plan) throw new ProvisionerError(422, `El plan "${t.plan_name}" no tiene equivalente en la infraestructura. Usa Básico, Estándar o Avanzado.`);
        if (t.region !== cfg.region) throw new ProvisionerError(422, `Por ahora solo se aprovisiona en ${cfg.region} (la imagen del sistema es de esa región).`);
        if (operation === 'destruir' && options.confirm !== slug) {
          throw new ProvisionerError(400, 'Para eliminar escribe el identificador del tenant como confirmación.');
        }
        const { rows: [row] } = await client.query(`
          INSERT INTO platform_jobs (tenant_id, operation, engine, plan, requested_by, retry_of)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, operation, engine`,
        [t.id, operation, t.engine, t.infra_plan, user.email, options.retryOf ?? null]);
        if (operation === 'crear') await setLifecycle(client, t.id, 'aprovisionando');
        if (operation === 'destruir') await setLifecycle(client, t.id, 'eliminando');
        return { ...row, tenantId: t.id, previousStatus: t.lifecycle_status };
      });
      queue.push(job);
      setImmediate(pump);
      return { id: job.id };
    } catch (error) {
      if (error.code === '23505' && error.constraint === 'platform_jobs_one_active_per_tenant') {
        throw new ProvisionerError(409, 'Este tenant ya tiene una operación en curso. Espera a que termine.');
      }
      throw error;
    }
  }

  // Si la plataforma se reinició mientras corría un trabajo, no queda "corriendo" para siempre
  async function recoverInterrupted() {
    const { rows } = await pool.query(`
      UPDATE platform_jobs SET status = 'failed', finished_at = now(), error_message = 'La plataforma se reinició mientras corría este trabajo. Reintenta: no duplica recursos.'
      WHERE status IN ('queued', 'running') RETURNING tenant_id, operation`);
    for (const row of rows) {
      await pool.query(`
        UPDATE platform_tenants SET lifecycle_status = CASE WHEN $2 IN ('crear', 'destruir') THEN 'error' ELSE lifecycle_status END,
        lifecycle_updated_at = now() WHERE id = $1`, [row.tenant_id, row.operation]);
    }
    return rows.length;
  }

  async function retry(jobId, user) {
    const { rows: [job] } = await pool.query(`${jobSelect} WHERE j.id = $1`, [jobId]);
    if (!job) throw new ProvisionerError(404, 'Trabajo no encontrado.');
    if (job.status !== 'failed') throw new ProvisionerError(409, 'Solo se pueden reintentar trabajos que fallaron.');
    if (job.operation === 'destruir') throw new ProvisionerError(400, 'Para eliminar de nuevo, vuelve a confirmar la eliminación.');
    return enqueue(job.slug, job.operation, user, { retryOf: job.id });
  }

  return { enqueue, retry, recoverInterrupted, settings };
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function mountProvisioning(platform, pool, provisioner) {
  platform.get('/tenants', async (request, response) => {
    const { q = '', status = '', plan = '', environment = '' } = request.query;
    const params = [];
    const where = [];
    const add = (sql, value) => { params.push(value); where.push(sql.replaceAll('?', `$${params.length}`)); };
    if (typeof q === 'string' && q.trim()) add('(r.institution_name ILIKE ? OR t.slug ILIKE ?)', `%${q.trim().slice(0, 80)}%`);
    if (typeof status === 'string' && status) add('t.lifecycle_status = ?', status);
    if (typeof plan === 'string' && plan) add('r.plan_id = ?', plan);
    if (typeof environment === 'string' && environment) add('t.environment = ?', environment);
    const { rows } = await pool.query(`
      SELECT t.id, t.slug, r.institution_name AS "institutionName", r.admin_email AS "adminEmail", r.plan_id AS "planId",
             p.name AS "planName", p.infra_plan AS "infraPlan", t.environment, t.engine, t.region,
             t.lifecycle_status AS "lifecycleStatus", t.lifecycle_updated_at AS "lifecycleUpdatedAt", t.deployed_url AS "deployedUrl",
             (SELECT json_build_object('id', j.id, 'operation', j.operation, 'status', j.status, 'createdAt', j.created_at)
                FROM platform_jobs j WHERE j.tenant_id = t.id ORDER BY j.created_at DESC LIMIT 1) AS "lastJob"
      FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id JOIN platform_plans p ON p.id = r.plan_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC`, params);
    response.json({ tenants: rows, allowed: ALLOWED, grafanaUrl: provisioner.settings().grafanaUrl || null });
  });

  platform.post('/tenants/:slug/operations', async (request, response) => {
    const { slug } = request.params;
    if (!SLUG.test(slug)) throw new ProvisionerError(400, 'Identificador de tenant inválido.');
    const job = await provisioner.enqueue(slug, request.body?.operation, response.locals.user, { confirm: request.body?.confirm });
    response.status(202).json(job);
  });

  platform.get('/tenants/:slug/credentials', async (request, response) => {
    const { slug } = request.params;
    if (!SLUG.test(slug)) throw new ProvisionerError(400, 'Identificador de tenant inválido.');
    const { rows: [t] } = await pool.query(`
      SELECT r.admin_email, t.lifecycle_status FROM platform_tenants t JOIN platform_requests r ON r.id = t.request_id WHERE t.slug = $1`, [slug]);
    if (!t || !['activo', 'suspendido'].includes(t.lifecycle_status)) throw new ProvisionerError(404, 'Este tenant no tiene credenciales disponibles.');
    try {
      const password = (await fs.readFile(path.join(provisioner.settings().root, 'infra', 'ansible', '.secrets', slug, 'admin_password'), 'utf8')).trim();
      response.json({ email: t.admin_email, password });
    } catch {
      throw new ProvisionerError(404, 'Las credenciales no están en este servidor.');
    }
  });

  platform.get('/jobs', async (request, response) => {
    const params = [];
    let where = '';
    if (typeof request.query.tenant === 'string' && SLUG.test(request.query.tenant)) {
      params.push(request.query.tenant);
      where = 'WHERE t.slug = $1';
    }
    const { rows } = await pool.query(`${jobSelect} ${where} ORDER BY j.created_at DESC LIMIT 100`, params);
    response.json({ jobs: rows });
  });

  platform.get('/jobs/:id', async (request, response) => {
    if (!UUID.test(request.params.id)) throw new ProvisionerError(400, 'Identificador de trabajo inválido.');
    const { rows: [job] } = await pool.query(`SELECT ${jobColumns}, j.log ${jobFrom} WHERE j.id = $1`, [request.params.id]);
    if (!job) throw new ProvisionerError(404, 'Trabajo no encontrado.');
    response.json({ job });
  });

  platform.post('/jobs/:id/retry', async (request, response) => {
    if (!UUID.test(request.params.id)) throw new ProvisionerError(400, 'Identificador de trabajo inválido.');
    response.status(202).json(await provisioner.retry(request.params.id, response.locals.user));
  });
}

module.exports = { ProvisionerError, createProvisioner, mountProvisioning };

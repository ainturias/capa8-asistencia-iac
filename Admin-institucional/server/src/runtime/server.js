const express = require('express');
const { mountMonitoring } = require('./monitoring');
const { ProvisionerError, createProvisioner, mountProvisioning } = require('./provisioner');
const { createPool, migrate, transaction } = require('./db');
const { InvitationError, allowedTenantOrigin, deliverInvitation, issueTenantInvitation, tenantIsActivated } = require('./invitations');
const {
  bootstrapAdmin, configuredAdmin, closeSession, limitLogins, newToken,
  openSession, sessionUser, tokenHash, tokenPattern, validEmail,
} = require('./security');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const requestSelect = `
  SELECT r.id, r.institution_name, r.admin_name, r.admin_email, r.plan_id,
         r.status, r.created_at, r.updated_at,
         t.id AS tenant_id, t.slug, t.region, t.environment, t.engine,
         t.created_at AS tenant_created_at, t.app_url, t.invitation_status, t.invitation_updated_at
  FROM platform_requests r
  LEFT JOIN platform_tenants t ON t.request_id = r.id
`;

const planSelect = `
  SELECT p.id, p.name, p.description, p.limit_students AS "limitStudents", p.database_gb AS "databaseGb", p.backup,
         COALESCE((
           SELECT json_agg(
             json_build_object(
               'role', i.role,
               'vcpu', i.vcpu,
               'ramGib', i.ram_gib,
               'systemDiskGb', i.system_disk_gb,
               'awsType', i.aws_type,
               'azureType', i.azure_type
             )
             ORDER BY CASE i.role WHEN 'frontend' THEN 1 WHEN 'backend' THEN 2 ELSE 3 END
           )
           FROM platform_plan_instances i
           WHERE i.plan_id = p.id
         ), '[]'::json) AS instances
  FROM platform_plans p
`;

function serializeRequest(row, includeContact = true) {
  const request = {
    id: row.id,
    institutionName: row.institution_name,
    planId: row.plan_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (includeContact) {
    request.adminName = row.admin_name;
    request.adminEmail = row.admin_email;
  }
  if (row.tenant_id) {
    const invitation = { invitationStatus: row.invitation_status };
    if (row.app_url) invitation.appUrl = row.app_url;
    if (row.invitation_updated_at) invitation.invitationUpdatedAt = row.invitation_updated_at;
    request.tenant = includeContact ? {
      ...invitation, id: row.tenant_id, slug: row.slug, region: row.region,
      environment: row.environment, engine: row.engine, createdAt: row.tenant_created_at,
    } : invitation;
  }
  return request;
}

function readText(value, label, min, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min || text.length > max || text.includes('\u0000')) {
    throw new HttpError(400, `${label} debe tener entre ${min} y ${max} caracteres.`);
  }
  return text;
}

function readPlanInteger(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 2147483647) {
    throw new HttpError(400, `${label} debe ser un número entero entre 1 y 2147483647.`);
  }
  return value;
}

function readPlan(body) {
  const name = readText(body?.name, 'El nombre del plan', 1, 80);
  const id = name.normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
    .replace(/-$/, '');
  if (!id) throw new HttpError(400, 'El nombre del plan debe incluir letras o números para formar su identificador.');

  const description = readText(body?.description, 'La descripción', 1, 500);
  const backup = readText(body?.backup, 'El respaldo', 1, 120);
  const limitStudents = readPlanInteger(body?.limitStudents, 'El límite de estudiantes');
  const databaseGb = readPlanInteger(body?.databaseGb, 'El almacenamiento de datos');
  const remainingRoles = new Set(['frontend', 'backend', 'database']);
  if (!Array.isArray(body?.instances) || body.instances.length !== remainingRoles.size) {
    throw new HttpError(400, 'Incluye una máquina de frontend, una de backend y una de base de datos.');
  }
  const instances = body.instances.map((instance) => {
    const role = instance?.role;
    if (!remainingRoles.delete(role)) {
      throw new HttpError(400, 'Usa los roles frontend, backend y database una sola vez cada uno.');
    }
    const ramGib = instance.ramGib;
    if (!Number.isFinite(ramGib) || ramGib < 0.01 || ramGib > 9999.99 || Number(ramGib.toFixed(2)) !== ramGib) {
      throw new HttpError(400, `La RAM de ${role} debe estar entre 0.01 y 9999.99 GiB y tener como máximo dos decimales.`);
    }
    return {
      role,
      ramGib,
      vcpu: readPlanInteger(instance.vcpu, `La cantidad de vCPU de ${role}`),
      systemDiskGb: readPlanInteger(instance.systemDiskGb, `El disco del sistema de ${role}`),
      awsType: readText(instance.awsType, `El tipo de AWS de ${role}`, 1, 80),
      azureType: readText(instance.azureType, `El tipo de Azure de ${role}`, 1, 80),
    };
  });
  return { id, name, description, backup, limitStudents, databaseGb, instances };
}

async function createPlan(pool, plan) {
  try {
    return await transaction(pool, async (client) => {
      await client.query(`
        INSERT INTO platform_plans (id, name, description, limit_students, database_gb, backup)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [plan.id, plan.name, plan.description, plan.limitStudents, plan.databaseGb, plan.backup]);

      for (const instance of plan.instances) {
        await client.query(`
          INSERT INTO platform_plan_instances (plan_id, role, vcpu, ram_gib, system_disk_gb, aws_type, azure_type)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [plan.id, instance.role, instance.vcpu, instance.ramGib, instance.systemDiskGb, instance.awsType, instance.azureType]);
      }
      const { rows: [saved] } = await client.query(`${planSelect} WHERE p.id = $1`, [plan.id]);
      return saved;
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_plans_pkey') {
      throw new HttpError(409, 'Ya existe un plan con ese identificador. Usa otro nombre.');
    }
    throw error;
  }
}

function tenantConfig(body) {
  const slug = readText(body?.slug, 'El slug', 3, 63).toLowerCase();
  const region = readText(body?.region, 'La región', 2, 40).toLowerCase();
  const environment = body?.environment;
  const engine = body?.engine;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new HttpError(400, 'El slug admite letras, números y guiones entre palabras.');
  }
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(region)) {
    throw new HttpError(400, 'Escribe una región válida, como us-east-1 o eastus.');
  }
  if (!['production', 'staging'].includes(environment)) {
    throw new HttpError(400, 'Selecciona un entorno válido.');
  }
  if (!['terraform', 'opentofu', 'pulumi', 'cloudformation'].includes(engine)) {
    throw new HttpError(400, 'Selecciona una herramienta de infraestructura válida.');
  }
  return { slug, region, environment, engine };
}

function requireRequestId(id) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) {
    throw new HttpError(400, 'Identificador de solicitud inválido.');
  }
}

async function registerTenant(pool, id, config) {
  requireRequestId(id);
  try {
    return await transaction(pool, async (client) => {
      const { rows: [current] } = await client.query(
        'SELECT status FROM platform_requests WHERE id = $1 FOR UPDATE', [id],
      );
      if (!current) throw new HttpError(404, 'Solicitud no encontrada.');
      if (current.status === 'pending') {
        await client.query(`
          INSERT INTO platform_tenants (request_id, slug, region, environment, engine)
          VALUES ($1, $2, $3, $4, $5)
        `, [id, config.slug, config.region, config.environment, config.engine]);
        await client.query("UPDATE platform_requests SET status = 'registered', updated_at = now() WHERE id = $1", [id]);
      }
      const { rows: [row] } = await client.query(`${requestSelect} WHERE r.id = $1`, [id]);
      if (Object.entries(config).some(([key, value]) => row[key] !== value)) {
        throw new HttpError(409, 'La solicitud ya se registró con otra configuración.');
      }
      return serializeRequest(row);
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_tenants_slug_key') {
      throw new HttpError(409, 'Ya hay una institución registrada con ese slug.');
    }
    throw error;
  }
}

async function inviteTenant(pool, id, body) {
  requireRequestId(id);
  const appUrl = allowedTenantOrigin(readText(body?.appUrl, 'La URL', 8, 253));
  const bootstrapKey = readText(body?.bootstrapKey, 'La clave de vinculación', 32, 200);
  if (!/^[a-zA-Z0-9_-]+$/.test(bootstrapKey)) {
    throw new HttpError(400, 'La clave de vinculación solo admite letras, números, guiones y guiones bajos.');
  }

  try {
    return await transaction(pool, async (client) => {
      const { rows: [tenant] } = await client.query(
        'SELECT id, app_url, invitation_status FROM platform_tenants WHERE request_id = $1 FOR UPDATE', [id],
      );
      if (!tenant) throw new HttpError(409, 'Registra la institución antes de vincular su instalación.');
      if (tenant.app_url && tenant.app_url !== appUrl) {
        throw new HttpError(409, 'Esta institución ya tiene una URL vinculada. Usa esa dirección para reenviar el acceso.');
      }
      const { rows: [row] } = await client.query(`${requestSelect} WHERE r.id = $1`, [id]);
      if (tenant.invitation_status === 'activated') return { request: serializeRequest(row) };

      await client.query('UPDATE platform_tenants SET app_url = $1 WHERE id = $2', [appUrl, tenant.id]);
      const email = row.admin_email;
      const name = row.admin_name;
      const issued = await issueTenantInvitation(appUrl, { bootstrapKey, slug: row.slug, email, name });
      const delivery = issued.activated ? { status: 'activated' } : await deliverInvitation({
        email, name, institutionName: row.institution_name, appUrl, activationUrl: issued.activationUrl,
      });
      const { rows: [updated] } = await client.query(`
        UPDATE platform_tenants SET invitation_status = $1, invitation_updated_at = now() WHERE id = $2
        RETURNING app_url, invitation_status, invitation_updated_at
      `, [delivery.status, tenant.id]);
      return { request: serializeRequest({ ...row, ...updated }), previewUrl: delivery.previewUrl };
    });
  } catch (error) {
    if (error.code === '23505' && error.constraint === 'platform_tenants_app_url_key') {
      throw new HttpError(409, 'Esta URL ya está vinculada a otra institución.');
    }
    throw error;
  }
}

async function refreshTenantActivation(pool, row) {
  if (!row.app_url || row.invitation_status === 'activated' || !(await tenantIsActivated(row.app_url))) return row;
  const { rows: [activated] } = await pool.query(`
    UPDATE platform_tenants SET invitation_status = 'activated', invitation_updated_at = now()
    WHERE id = $1 AND invitation_status <> 'activated'
    RETURNING invitation_status, invitation_updated_at
  `, [row.tenant_id]);
  return { ...row, invitation_status: 'activated', ...activated };
}

function createApp(pool, platformOnly, provisioner) {
  const app = express();
  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.set('Cache-Control', 'no-store');
    const mutates = request.method === 'POST' || request.method === 'DELETE';
    if (mutates && request.get('Sec-Fetch-Site') === 'cross-site') {
      throw new HttpError(403, 'Envía la solicitud desde el sitio de la plataforma.');
    }
    if (request.method === 'POST' && !request.is('application/json')) {
      throw new HttpError(415, 'Envía el cuerpo de la solicitud en JSON.');
    }
    next();
  });
  app.use(express.json({ limit: '16kb' }));

  const healthPaths = platformOnly ? ['/api/health', '/api/platform/health'] : '/api/platform/health';
  app.get(healthPaths, async (_request, response) => {
    try {
      await pool.query('SELECT 1');
      response.json({ status: 'ok' });
    } catch {
      response.status(503).json({ message: 'La base de datos de la plataforma no está disponible.' });
    }
  });

  app.get('/api/plans', async (_request, response) => {
    const { rows } = await pool.query(`${planSelect} ORDER BY p.limit_students, p.id`);
    response.json({ plans: rows });
  });

  app.post('/api/requests', async (request, response) => {
    const body = request.body;
    const institution = readText(body?.institutionName, 'El nombre de la institución', 2, 160);
    const name = readText(body?.adminName, 'El nombre del administrador', 2, 120);
    const email = readText(body?.adminEmail, 'El correo del administrador', 3, 254).toLowerCase();
    const plan = readText(body?.planId, 'El plan', 1, 40);
    if (!validEmail(email)) throw new HttpError(400, 'Ingresa un correo válido.');
    const trackingToken = newToken();
    const { rows: [row] } = await pool.query(`
      INSERT INTO platform_requests (institution_name, admin_name, admin_email, plan_id, tracking_token_hash)
      SELECT $1, $2, $3, id, $5 FROM platform_plans WHERE id = $4
      RETURNING id, institution_name, admin_name, admin_email, plan_id, status, created_at, updated_at
    `, [institution, name, email, plan, tokenHash(trackingToken)]);
    if (!row) throw new HttpError(400, 'El plan seleccionado no existe.');
    response.status(201).json({ request: serializeRequest(row), trackingToken });
  });

  app.get('/api/requests/track/:token', async (request, response) => {
    const token = request.params.token;
    if (!tokenPattern.test(token)) throw new HttpError(404, 'Solicitud no encontrada.');
    const { rows: [row] } = await pool.query(`${requestSelect} WHERE r.tracking_token_hash = $1`, [tokenHash(token)]);
    if (!row) throw new HttpError(404, 'Solicitud no encontrada.');
    response.json({ request: serializeRequest(await refreshTenantActivation(pool, row), false) });
  });

  const platform = express.Router();
  platform.post('/session', limitLogins(), async (request, response) => {
    const email = readText(request.body?.email, 'El correo', 3, 254).toLowerCase();
    const password = request.body?.password;
    if (typeof password !== 'string' || !password || password.length > 256) {
      throw new HttpError(401, 'Correo o contraseña incorrectos.');
    }
    const user = await openSession(pool, request, response, email, password);
    if (!user) throw new HttpError(401, 'Correo o contraseña incorrectos.');
    response.json({ user });
  });

  platform.use(async (request, response, next) => {
    const user = await sessionUser(pool, request);
    if (!user) throw new HttpError(401, 'Inicia sesión como operador de la plataforma.');
    response.locals.user = user;
    next();
  });

  platform.get('/session', (_request, response) => {
    response.json({ user: response.locals.user });
  });

  platform.delete('/session', async (request, response) => {
    await closeSession(pool, request, response);
    response.sendStatus(204);
  });

  platform.post('/plans', async (request, response) => {
    const plan = await createPlan(pool, readPlan(request.body));
    response.status(201).json({ plan });
  });

  platform.get('/requests', async (_request, response) => {
    const { rows } = await pool.query(`${requestSelect} ORDER BY r.created_at DESC, r.id DESC`);
    response.json({ requests: rows.map((row) => serializeRequest(row)) });
  });

  platform.post('/requests/:id/register', async (request, response) => {
    const registered = await registerTenant(pool, request.params.id, tenantConfig(request.body));
    response.json({ request: registered });
  });

  platform.post('/requests/:id/invitation', async (request, response) => {
    response.json(await inviteTenant(pool, request.params.id, request.body));
  });

  mountProvisioning(platform, pool, provisioner);
  mountMonitoring(platform, pool);
  app.use('/api/platform', platform);
  app.use((_request, _response, next) => next(new HttpError(404, 'Ruta no encontrada.')));
  app.use((error, _request, response, _next) => {
    if (error instanceof HttpError || error instanceof InvitationError || error instanceof ProvisionerError) {
      return response.status(error.status).json({ message: error.message });
    }
    if (error.type === 'entity.parse.failed') {
      return response.status(400).json({ message: 'El cuerpo de la solicitud contiene JSON inválido.' });
    }
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ message: 'La solicitud supera el tamaño permitido.' });
    }
    if (error.status === 400) return response.status(400).json({ message: 'Solicitud inválida.' });
    console.error('Error interno de la API de plataforma.', error.code ?? error.name);
    return response.status(500).json({ message: 'Ocurrió un error en la plataforma.' });
  });
  return app;
}

async function openPlatform(connectionString, platformOnly) {
  const admin = configuredAdmin();
  const pool = createPool(connectionString);
  pool.on('error', (error) => console.error('Conexión PostgreSQL cerrada.', error.code ?? error.name));
  try {
    await migrate(pool);
    await bootstrapAdmin(pool, admin);
    const provisioner = createProvisioner(pool);
    const interrupted = await provisioner.recoverInterrupted();
    if (interrupted) console.warn(`Se marcaron ${interrupted} trabajo(s) interrumpido(s) por el reinicio.`);
    return { handle: createApp(pool, platformOnly, provisioner), close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

module.exports = { openPlatform };

# Plataforma central

Aquí entra el operador para consultar planes, recibir solicitudes, registrar
instituciones y vincular instalaciones de asistencia. La plataforma guarda
planes, solicitudes, tenants y sesiones del operador en su propia base PostgreSQL.

## Arranque local

1. Crea una base PostgreSQL para la plataforma y un usuario con permisos para
   aplicar las migraciones de esa base.
2. En `server/`, copia `.env.example` a `.env` y configura
   `PLATFORM_DATABASE_URL`, `PLATFORM_ADMIN_EMAIL` y `PLATFORM_ADMIN_PASSWORD`.
   En PowerShell puedes usar `Copy-Item .env.example .env`.
3. Desde `server/`, ejecuta `npm ci` y `npm start`. El backend aplica las
   migraciones en `server/src/migrations/` y escucha en el puerto 4300.
4. En otra terminal, desde `client/`, ejecuta `npm ci` y `npm run dev`.
   Vite sirve la landing en `http://127.0.0.1:5175/` y redirige `/api` al backend.
5. Abre `http://127.0.0.1:5175/plataforma/login` para entrar como operador.

## Vinculación con asistencia

Registra la solicitud de la institución y vincula su instalación mediante su
URL pública y su clave de vinculación. La URL debe estar habilitada en
`PLATFORM_TENANT_ORIGINS`. El backend central usa esa URL para consultar
`/api/health` y solicitar el enlace de activación al backend académico.

Para desarrollo, `PLATFORM_MAIL_TRANSPORT=preview` permite copiar el enlace desde
el panel. Para correo real, configura las variables SMTP del ejemplo. Consulta
también la [guía de la API](server/README.md).

## Despliegue de infraestructura (runner)

Las pestañas **Despliegues**, **Monitoreo** y **Auditoría** ejecutan `infra/scripts/tenant.sh` en segundo plano y consultan Grafana.
El servidor necesita las herramientas y credenciales descritas en [`infra/README.md`](../infra/README.md) y estas variables en `server/.env`
(ver `.env.example`): `PROVISIONER_AMI_ID`, `PROVISIONER_REGION`, `PROVISIONER_CONCURRENCY` y `PLATFORM_GRAFANA_URL`.
Los procesos hijos solo reciben una lista blanca de variables de entorno y el registro oculta contraseñas y claves.

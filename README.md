# Sistema de registro y control de asistencia

Este repositorio contiene dos proyectos. Cada proyecto tiene su propio frontend,
backend, dependencias y migraciones de PostgreSQL.

| Proyecto | Usuarios y funciones | Frontend local | API local |
| --- | --- | --- | --- |
| [Admin-institucional](Admin-institucional/) | Operador de la plataforma. Landing, catálogo, solicitudes, instituciones, invitaciones y pantallas de monitoreo y auditoría. | `http://127.0.0.1:5175` | `http://127.0.0.1:4300/api` |
| [admin-docente-alumno](admin-docente-alumno/) | Administrador de la institución, docentes y estudiantes. Gestión docente, módulos, asistencias y Excel. | `http://localhost:5173` | `http://localhost:3000/api` |

## Arranque local

Usa Node.js 22.12 o posterior y PostgreSQL. Crea una base y un usuario para la
plataforma y otra base con su propio usuario para la institución. Sigue los pasos
de cada proyecto para preparar su `server/.env` desde `.env.example`. Cada backend
aplica sus propias migraciones al iniciar.

1. [Iniciar la plataforma central](Admin-institucional/README.md).
2. [Iniciar la aplicación de asistencia](admin-docente-alumno/README.md).

Para vincular una instalación, el backend central consulta la URL pública de
asistencia y solicita por HTTP una invitación para su administrador. Habilita esa
URL en `PLATFORM_TENANT_ORIGINS` del backend central. Configura
`PLATFORM_TENANT_SLUG` y `PLATFORM_BOOTSTRAP_KEY` en el backend de asistencia.
Cada backend conserva sus usuarios y sus datos en su propia base.

El alta directa de instituciones, la auditoría y el monitoreo tienen pantallas
de demostración. El flujo de solicitudes e invitaciones usa la API y la base de
la plataforma. El aprovisionamiento automático desde el panel está pendiente.

## Aprovisionamiento de tenants (proyecto final de Infraestructura como Código)

La plataforma central puede crear, suspender, reanudar y eliminar la infraestructura de cada institución en AWS (3 máquinas por tenant:
frontend, backend y base de datos propia) con OpenTofu, Terraform, Pulumi o CloudFormation, y monitorearla con Prometheus y Grafana.

- Puesta en marcha, requisitos y costos: [`infra/README.md`](infra/README.md)
- Estado y secretos (cómo se protegen): [`docs/estado-y-secretos.md`](docs/estado-y-secretos.md)
- Catálogo de planes: [`docs/catalogo-de-planes.md`](docs/catalogo-de-planes.md)
- Diagramas de arquitectura, flujo y ciclo de vida: [`docs/diagramas/`](docs/diagramas)
- Evidencia de aislamiento entre tenants: [`docs/evidencias/`](docs/evidencias)

# Catálogo de planes (RF-01, RF-02)

Definido en `infra/modules/tenant/main.tf` (`local.plans`). Cada plan decide tamaño de las VMs y de los discos de cada tenant.

| Plan | Frontend y backend | Base de datos | Disco app | Disco BD | Límite orientativo |
|---|---|---|---|---|---|
| **basic** | t3.micro (2 vCPU, 1 GB) | t3.micro | 10 GB | 10 GB | hasta 100 estudiantes |
| **standard** | t3.small (2 vCPU, 2 GB) | t3.small | 20 GB | 20 GB | hasta 1 000 estudiantes |
| **advanced** | t3.medium (2 vCPU, 4 GB) | t3.medium | 30 GB | 50 GB | hasta 5 000 estudiantes |

Todos incluyen: 3 VMs (frontend, backend, BD) con base de datos propia, discos cifrados, IP fija en el frontend,
monitoreo en Grafana y suspensión/reanudación. El límite de estudiantes es orientativo (RF-05 es opcional y no se aplica por código).

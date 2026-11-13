# Evidencia: aislamiento entre tenants (13-nov-2026)

Prueba real en AWS (us-east-2) con dos tenants: `demo` (plan basic, **OpenTofu**) y `demo2` (plan standard, **Terraform**, AMI de Packer).

| Prueba | Resultado esperado | Resultado |
|---|---|---|
| Token de `demo` usado en la API de `demo2` | 401 | **401** |
| Token de `demo2` usado en la API de `demo` | 401 | **401** |
| Credenciales del admin de `demo` en el login de `demo2` | 401 | **401** |
| Bases de datos en el servidor de `demo` | solo `asistencia_demo` | `asistencia_demo` |
| Bases de datos en el servidor de `demo2` | solo `asistencia_demo2` | `asistencia_demo2` |
| Puerto 5432 (BD) desde internet | bloqueado | **bloqueado** |
| Puerto 3000 (backend) desde internet | bloqueado | **bloqueado** |
| Tipos de instancia por plan | basic=t3.micro, standard=t3.small | **coincide** |

Por qué ocurre: cada tenant tiene su propia VM de BD, su propio `JWT_SECRET` y sus propios grupos de seguridad
(la BD solo acepta al backend de su tenant; el backend solo al frontend de su tenant).
Los recursos de prueba se destruyeron después (`destruir`), sin recursos residuales.

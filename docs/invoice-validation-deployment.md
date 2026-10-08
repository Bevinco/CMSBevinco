# Validación privada de facturas

La prueba permite abrir originales, revisar conversiones y guardar/confirmar borradores. Reutiliza el servicio Render y el proyecto Supabase existentes. No requiere otro servicio, rama de base de datos ni plan. Las seis referencias y el catálogo se suministran en un archivo privado fuera de este repositorio público.

## Comprobaciones antes de publicar

- `npm run test:invoicing` prueba permisos, persistencia, concurrencia, duplicados y SQL en PGlite local.
- `npm run build` comprueba tipos y genera por separado `dist` y `dist-review`; Docker copia ambos. La aplicación privada no se sirve desde el directorio público del CMS.
- Revisar capacidad y consumo de los recursos existentes. Desactivar lectura automática evita llamadas nuevas al proveedor de IA, pero no convierte en ilimitadas las cuotas de infraestructura.
- Obtener la aprobación de publicación. El push a `main` activa el despliegue.

## Activación tras aprobación

1. Aplicar `migrations/20261007_kitchen_invoices.sql` con `apply_migration` en el proyecto existente. Solo crea tablas y función dedicadas; no modifica `cms_store`.
2. Ejecutar `node scripts/import-invoice-pilot.mjs /ruta/privada/pilot-seed.json` para validar el lote sin escrituras. Con las credenciales de almacenamiento en el entorno, agregar `--apply` para importar las seis referencias y catálogo. El importador verifica los originales y no reemplaza revisiones existentes. Requiere las tablas del paso anterior.
3. Configurar `INVOICING_ENABLED=true`, `INVOICING_REVIEWER_ID=<id exacto del usuario CMS>`, `INVOICING_VALIDATION_ONLY=true`, `INVOICE_EXTRACTION_ENABLED=false`. Las credenciales de la base ya existentes se reutilizan; nunca copiar claves al cliente o al repositorio.
4. Incorporar la rama aprobada a `main` y esperar el despliegue `live`.
5. Comprobar el menú «Validación de facturas» con la cuenta asignada, apertura de los seis originales, guardado/reapertura y confirmación. Comprobar rechazo para otra cuenta, enlace directo, originales y API. Una cuenta con rol Superadmin o una llave API no obtiene acceso por su rol.

La sección se abre en `/revision-facturas/` con la sesión del CMS. El usuario se verifica por ID y existencia actual en el CMS. La función de lectura automática y la exportación se bloquean en el servidor en modo validación, incluso si hay una clave de IA en el entorno. No existe escritura automática en Sculpture desde este módulo.

## Desactivación

Desactivar `INVOICING_ENABLED` y desplegar oculta la entrada y bloquea pantalla/API sin eliminar documentos. El CMS general y su tabla continúan intactos. No borrar tablas para revertir la visibilidad.

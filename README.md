# Bevinco CMS

CMS modular para automatizar los reportes semanales de auditoria y preparar futuros modulos operativos.

## Alcance del MVP

- Dashboard central para seguimiento de reportes.
- Modulo de reportes con estados: borrador, listo para revisar y enviado.
- Borrador editable para comentarios asistidos por IA.
- Base inicial de criterios de auditoria por cliente.
- Panel de operacion para fuentes de datos, revision y envio.
- Vista futura de reservas y pagos con alertas visuales.

## Requisitos levantados de la reunion

- Automatizar reportes descargados hoy desde Sculpture Hospitality y planillas Excel.
- Mantener el formato familiar de graficos y resumen semanal.
- Permitir edicion humana de comentarios antes del envio final.
- Disparar borradores desde ClickUp cuando una auditoria pase a "Listo para reporte".
- Preparar envio multicanal: correo con cuerpo, PDF adjunto y posible resumen por WhatsApp.
- Documentar criterios de analisis por cliente sin perder flexibilidad.
- Evolucionar a reservas con codigos, proveedores, pasajeros, vencimientos de pago y alertas.

## Desarrollo

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Produccion en Render

Usar estos comandos:

```bash
npm install
npm run build
npm run start
```

El backend Express sirve el sitio compilado y expone endpoints seguros para autenticacion, reportes e importacion de datos:

```bash
GET /api/module1/bootstrap
POST /api/module1/import-csv
GET /api/module1/reports/:reportId/export
```

El CMS requiere login por usuario y contrasena. Las credenciales se leen desde variables de entorno del servidor.

## Variables de entorno

Copiar `.env.example` a `.env` y completar las claves cuando esten disponibles.

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_RESEND_API_KEY=
VITE_REPORTS_FROM_EMAIL=
CLICKUP_API_TOKEN=
CLICKUP_ACCESS_TOKEN=
CLICKUP_CLIENT_ID=
CLICKUP_CLIENT_SECRET=
CLICKUP_LIST_ID=
VITE_SCULPTURE_API_BASE_URL=
VITE_SCULPTURE_API_KEY=
VITE_OPENAI_API_KEY=
SCULPTURE_BASE_URL=https://beta.food.sculpturehospitality.com
SCULPTURE_FOOD_BASE_URL=https://beta.food.sculpturehospitality.com
SCULPTURE_BEVERAGE_BASE_URL=https://beta.beverage.sculpturehospitality.com
SCULPTURE_SESSION_COOKIE=
SCULPTURE_USERNAME=
SCULPTURE_PASSWORD=
SCULPTURE_LOGIN_PATH=/login/
SCULPTURE_LOGIN_USERNAME_FIELD=
SCULPTURE_LOGIN_PASSWORD_FIELD=
SCULPTURE_DEFAULT_CID=29088
SCULPTURE_DEFAULT_PID=36
SCULPTURE_VARIANCE_DETAILED_PATH=/reports/variance/
SCULPTURE_VARIANCE_DETAILED_CMD=variance
SCULPTURE_VARIANCE_SUMMARY_PATH=/reports/variance/
SCULPTURE_VARIANCE_SUMMARY_CMD=variance
SCULPTURE_INTELIPAR_PATH=/reports/intelipar/
SCULPTURE_INTELIPAR_CMD=overview
CMS_AUTH_USERNAME=
CMS_AUTH_PASSWORD=
CMS_SESSION_SECRET=
```

`SCULPTURE_SESSION_COOKIE` debe configurarse solo en Render o en `.env` local. No se debe commitear porque permite acceder a la sesion activa de Sculpture. Si la cookie falta o vence, el servidor intenta iniciar sesion con `SCULPTURE_USERNAME` y `SCULPTURE_PASSWORD`.
`CMS_SESSION_SECRET` debe ser un texto largo y aleatorio para mantener firmadas las sesiones del CMS.
Para ClickUp, usar `CLICKUP_API_TOKEN` si se trabaja con token personal. Si se usa OAuth, configurar `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET` y conectar desde el CMS con el `code`; el endpoint de intercambio usado es `POST /oauth/token`. `CLICKUP_LIST_ID` define la lista donde se crean las tareas de reportes.

El CMS intenta traer Variance detailed, Variance summary e Intelipar desde los endpoints internos de Sculpture al sincronizar fuentes y antes de generar el reporte. Desde Modulo 1 se puede buscar la lista de unidades visibles en Sculpture, importar la unidad al CMS y guardar su `sculptureCid` con el host correcto de Food o Beverage. Para periodos reales, guardar `sculpturePid`/`pid`; si faltan, usa `SCULPTURE_DEFAULT_CID` y `SCULPTURE_DEFAULT_PID`.

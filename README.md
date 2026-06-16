# Bevinco CMS

CMS modular para automatizar los reportes semanales de auditoria y preparar futuros modulos operativos.

## Alcance del MVP

- Dashboard central para seguimiento de reportes.
- Modulo de reportes con estados: borrador, listo para revisar y enviado.
- Borrador editable para comentarios asistidos por IA.
- Base inicial de criterios de auditoria por cliente.
- Panel de integraciones pendientes: Sculpture Hospitality, ClickUp, Supabase y Resend.
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

El backend Express sirve el sitio compilado y expone el endpoint seguro:

```bash
GET /api/sculpture/requisition
```

## Variables de entorno

Copiar `.env.example` a `.env` y completar las claves cuando esten disponibles.

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_RESEND_API_KEY=
VITE_REPORTS_FROM_EMAIL=
VITE_CLICKUP_API_TOKEN=
VITE_CLICKUP_LIST_ID=
VITE_SCULPTURE_API_BASE_URL=
VITE_SCULPTURE_API_KEY=
VITE_OPENAI_API_KEY=
SCULPTURE_BASE_URL=https://beta.food.sculpturehospitality.com
SCULPTURE_SESSION_COOKIE=
SCULPTURE_DEFAULT_CID=29088
SCULPTURE_DEFAULT_PID=36
```

`SCULPTURE_SESSION_COOKIE` debe configurarse solo en Render o en `.env` local. No se debe commitear porque permite acceder a la sesion activa de Sculpture.

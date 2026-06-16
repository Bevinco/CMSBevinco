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
```

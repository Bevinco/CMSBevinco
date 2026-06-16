import React from "react";
import ReactDOM from "react-dom/client";
import {
  AlertTriangle,
  BarChart3,
  Bell,
  Bot,
  CheckCircle2,
  ClipboardList,
  Cloud,
  FileSpreadsheet,
  LayoutDashboard,
  Mail,
  PencilLine,
  Send,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import "./styles.css";

type ReportStatus = "Borrador" | "Listo para revisar" | "Enviado";
type AlertLevel = "ok" | "warning" | "danger";

const reports = [
  {
    id: "REP-1042",
    client: "Restaurante Central",
    audit: "Semana 24",
    status: "Listo para revisar" as ReportStatus,
    cost: "28.4%",
    variance: "-3.1%",
    updated: "15 Jun 2026",
  },
  {
    id: "REP-1041",
    client: "Hotel Costa Sur",
    audit: "Semana 24",
    status: "Borrador" as ReportStatus,
    cost: "31.2%",
    variance: "+1.7%",
    updated: "15 Jun 2026",
  },
  {
    id: "REP-1040",
    client: "Bar Patagonia",
    audit: "Semana 23",
    status: "Enviado" as ReportStatus,
    cost: "24.9%",
    variance: "-0.8%",
    updated: "12 Jun 2026",
  },
];

const criteria = [
  "Comparar ventas, inventario y compras por categoria.",
  "Marcar proveedores desactualizados antes de sugerir compras.",
  "Mantener comentarios editables antes del envio.",
  "Respetar el formato historico de graficos y resumen semanal.",
];

const reservations = [
  {
    code: "ANT-250-0726",
    service: "Alojamiento + excursion glaciar",
    provider: "Antares Patagonia",
    passengers: 14,
    due: "18 Jun 2026",
    alert: "danger" as AlertLevel,
  },
  {
    code: "ANT-251-0826",
    service: "Traslado + navegacion",
    provider: "Proveedor tercero",
    passengers: 8,
    due: "22 Jun 2026",
    alert: "warning" as AlertLevel,
  },
  {
    code: "ANT-252-0926",
    service: "Full day Torres",
    provider: "Operador local",
    passengers: 6,
    due: "29 Jun 2026",
    alert: "ok" as AlertLevel,
  },
];

const integrations = [
  { name: "Sculpture Hospitality", detail: "API o credenciales como contingencia", ready: false },
  { name: "ClickUp", detail: "Disparar borradores al pasar a Listo para reporte", ready: false },
  { name: "Supabase", detail: "Base de datos, usuarios y permisos", ready: false },
  { name: "Resend", detail: "Envio de reportes por correo con PDF adjunto", ready: false },
];

function statusClass(status: ReportStatus) {
  if (status === "Enviado") return "pill success";
  if (status === "Listo para revisar") return "pill warning";
  return "pill neutral";
}

function alertClass(alert: AlertLevel) {
  if (alert === "danger") return "signal danger";
  if (alert === "warning") return "signal warning";
  return "signal ok";
}

function App() {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>Bevinco CMS</strong>
            <span>Reportes y operaciones</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Modulos">
          <a href="#dashboard" className="active"><LayoutDashboard size={18} /> Inicio</a>
          <a href="#reports"><ClipboardList size={18} /> Reportes</a>
          <a href="#criteria"><ShieldCheck size={18} /> Criterios</a>
          <a href="#reservations"><Bell size={18} /> Reservas</a>
          <a href="#integrations"><Cloud size={18} /> Integraciones</a>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar" id="dashboard">
          <div>
            <p className="eyebrow">MVP operativo</p>
            <h1>Centro de gestion para reportes semanales</h1>
          </div>
          <button className="primary-button"><Send size={18} /> Nuevo reporte</button>
        </header>

        <section className="metrics" aria-label="Resumen">
          <article>
            <span><FileSpreadsheet size={18} /> Reportes activos</span>
            <strong>12</strong>
            <small>3 listos para revision</small>
          </article>
          <article>
            <span><Users size={18} /> Clientes</span>
            <strong>8</strong>
            <small>Formatos configurables</small>
          </article>
          <article>
            <span><BarChart3 size={18} /> Variance promedio</span>
            <strong>-1.4%</strong>
            <small>Ultimas 4 semanas</small>
          </article>
          <article>
            <span><AlertTriangle size={18} /> Alertas reservas</span>
            <strong>2</strong>
            <small>Pagos por gestionar</small>
          </article>
        </section>

        <section className="module-grid">
          <div className="panel report-panel" id="reports">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Modulo 1</p>
                <h2>Reportes Sculpture</h2>
              </div>
              <button className="icon-button" aria-label="Configurar reportes"><Settings size={18} /></button>
            </div>

            <div className="table">
              <div className="table-row table-head">
                <span>Reporte</span>
                <span>Cliente</span>
                <span>Costo</span>
                <span>Variance</span>
                <span>Estado</span>
              </div>
              {reports.map((report) => (
                <div className="table-row" key={report.id}>
                  <span>
                    <strong>{report.id}</strong>
                    <small>{report.audit} · {report.updated}</small>
                  </span>
                  <span>{report.client}</span>
                  <span>{report.cost}</span>
                  <span>{report.variance}</span>
                  <span className={statusClass(report.status)}>{report.status}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel draft-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Analisis asistido</p>
                <h2>Borrador editable</h2>
              </div>
              <Bot size={22} />
            </div>
            <textarea
              aria-label="Comentario de reporte"
              defaultValue={"El costo semanal se mantiene bajo control, con variaciones relevantes en categorias de alto volumen. Revisar compras sugeridas antes del envio final y validar proveedores asociados a productos con cambios recientes."}
            />
            <div className="action-row">
              <button><PencilLine size={17} /> Editar</button>
              <button><Mail size={17} /> Preparar email</button>
            </div>
          </div>
        </section>

        <section className="split-section">
          <div className="panel" id="criteria">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Base reusable</p>
                <h2>Criterios de auditoria</h2>
              </div>
              <button className="secondary-button">Agregar</button>
            </div>
            <ul className="criteria-list">
              {criteria.map((item) => <li key={item}><CheckCircle2 size={18} /> {item}</li>)}
            </ul>
          </div>

          <div className="panel" id="integrations">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Pendiente de accesos</p>
                <h2>Integraciones</h2>
              </div>
              <Cloud size={22} />
            </div>
            <div className="integration-list">
              {integrations.map((item) => (
                <div className="integration-item" key={item.name}>
                  <span className="dot" />
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.detail}</small>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel" id="reservations">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Modulo futuro</p>
              <h2>Reservas y pagos Antares Patagonia</h2>
            </div>
            <button className="secondary-button"><Bell size={17} /> Notificar</button>
          </div>
          <div className="reservation-grid">
            {reservations.map((reservation) => (
              <article key={reservation.code} className="reservation-card">
                <span className={alertClass(reservation.alert)} />
                <strong>{reservation.code}</strong>
                <p>{reservation.service}</p>
                <small>{reservation.provider} · {reservation.passengers} pasajeros · vence {reservation.due}</small>
              </article>
            ))}
          </div>
        </section>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

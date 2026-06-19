import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  BarChart3,
  Bell,
  Bot,
  CheckCircle2,
  ClipboardList,
  Cloud,
  Database,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  ListChecks,
  Mail,
  PencilLine,
  Send,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Workflow,
} from "lucide-react";
import "./styles.css";

type ReportStatus = "Borrador" | "Listo para revisar" | "Enviado";
type AlertLevel = "ok" | "warning" | "danger";
type ConnectorStatus = "idle" | "loading" | "ready" | "error";

type SculptureRow = {
  group: string;
  values: string[];
  record: Record<string, string>;
};

type SculptureResponse = {
  headers: string[];
  rows: SculptureRow[];
  cid: string;
  pid: string;
};

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

const moduleRoadmap = [
  {
    number: "01",
    title: "Reportes Bevinco",
    status: "MVP activo",
    description: "Automatiza Variance Report e Intelipar desde Sculpture, permite revisar comentarios y preparar envio.",
    items: ["Variance detailed y summary", "Intelipar", "Comentarios editables", "PDF y email"],
  },
  {
    number: "02",
    title: "Clientes y criterios",
    status: "Base inicial",
    description: "Define reglas por cliente para mantener criterio operativo sin perder flexibilidad.",
    items: ["Clientes", "Categorias", "Reglas", "Formatos"],
  },
  {
    number: "03",
    title: "Integraciones",
    status: "En preparacion",
    description: "Centraliza conexiones con Sculpture, ClickUp, Supabase, Resend y futuras fuentes.",
    items: ["Sculpture", "ClickUp", "Supabase", "Resend"],
  },
  {
    number: "04",
    title: "Reservas y pagos",
    status: "Futuro",
    description: "Gestiona reservas, proveedores, codigos, pasajeros, vencimientos y alertas visuales.",
    items: ["Reservas", "Pagos", "Alertas", "Proveedores"],
  },
];

const reportWorkflow = [
  {
    icon: Database,
    title: "Sincronizar datos",
    detail: "Traer datos desde Sculpture por cliente, periodo y tipo de reporte.",
  },
  {
    icon: BarChart3,
    title: "Variance Report",
    detail: "Leer food cost / pour cost en vista detailed y summary.",
  },
  {
    icon: ShoppingCart,
    title: "Intelipar",
    detail: "Obtener sugerencias de compra, stock disponible y faltantes.",
  },
  {
    icon: Bot,
    title: "Analisis asistido",
    detail: "Generar comentario base editable con criterios del cliente.",
  },
  {
    icon: Send,
    title: "Revision y envio",
    detail: "Preparar correo, PDF adjunto y registro de estado.",
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
  const [connectorStatus, setConnectorStatus] = useState<ConnectorStatus>("idle");
  const [connectorError, setConnectorError] = useState("");
  const [sculptureData, setSculptureData] = useState<SculptureResponse | null>(null);

  async function loadSculptureRequisition() {
    setConnectorStatus("loading");
    setConnectorError("");

    try {
      const response = await fetch("/api/sculpture/requisition");
      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "No se pudo cargar Sculpture.");
      }

      setSculptureData(payload);
      setConnectorStatus("ready");
    } catch (error) {
      setConnectorError(error instanceof Error ? error.message : "Error desconocido.");
      setConnectorStatus("error");
    }
  }

  useEffect(() => {
    loadSculptureRequisition();
  }, []);

  const previewRows = useMemo(() => sculptureData?.rows.slice(0, 8) || [], [sculptureData]);

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
          <a href="#module-reports"><ClipboardList size={18} /> Modulo 1</a>
          <a href="#roadmap"><Workflow size={18} /> Roadmap</a>
          <a href="#criteria"><ShieldCheck size={18} /> Criterios</a>
          <a href="#reservations"><Bell size={18} /> Reservas</a>
          <a href="#integrations"><Cloud size={18} /> Integraciones</a>
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar" id="dashboard">
          <div>
            <p className="eyebrow">CMS modular</p>
            <h1>Modulo 1: reportes automatizados Bevinco</h1>
          </div>
          <button className="primary-button"><Send size={18} /> Nuevo reporte</button>
        </header>

        <section className="metrics" aria-label="Resumen">
          <article>
            <span><FileSpreadsheet size={18} /> Modulo activo</span>
            <strong>01</strong>
            <small>Reportes Bevinco</small>
          </article>
          <article>
            <span><FileText size={18} /> Reportes fuente</span>
            <strong>2</strong>
            <small>Variance e Intelipar</small>
          </article>
          <article>
            <span><Cloud size={18} /> Conector</span>
            <strong>1</strong>
            <small>Sculpture web endpoint</small>
          </article>
          <article>
            <span><ListChecks size={18} /> Roadmap</span>
            <strong>4</strong>
            <small>Modulos planificados</small>
          </article>
        </section>

        <section className="module-roadmap" id="roadmap" aria-label="Roadmap de modulos">
          {moduleRoadmap.map((module) => (
            <article className="module-card" key={module.number}>
              <div className="module-card-top">
                <span>{module.number}</span>
                <small>{module.status}</small>
              </div>
              <h2>{module.title}</h2>
              <p>{module.description}</p>
              <div className="module-tags">
                {module.items.map((item) => <span key={item}>{item}</span>)}
              </div>
            </article>
          ))}
        </section>

        <section className="panel module-one" id="module-reports">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Primer modulo propuesto</p>
              <h2>Reportes Bevinco/Sculpture</h2>
            </div>
            <span className="pill success">En desarrollo</span>
          </div>
          <div className="workflow-list">
            {reportWorkflow.map((step) => {
              const Icon = step.icon;
              return (
                <article key={step.title}>
                  <Icon size={20} />
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.detail}</small>
                  </div>
                </article>
              );
            })}
          </div>
        </section>

        <section className="panel connector-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Conector del modulo 1</p>
              <h2>Requisition & Transfers</h2>
            </div>
            <button className="secondary-button" onClick={loadSculptureRequisition}>
              <Cloud size={17} /> Sincronizar
            </button>
          </div>

          <div className="connector-meta">
            <span className={`connector-state ${connectorStatus}`}>{connectorStatus}</span>
            {sculptureData ? (
              <small>cid {sculptureData.cid} - pid {sculptureData.pid} - {sculptureData.rows.length} filas</small>
            ) : (
              <small>Esperando variables SCULPTURE en el servidor</small>
            )}
          </div>

          {connectorError ? <p className="connector-error">{connectorError}</p> : null}

          <div className="sculpture-table">
            <div className="sculpture-row sculpture-head">
              <span>Grupo</span>
              <span>Item</span>
              <span>Unidad</span>
              <span>Tamano</span>
              <span>Cocina In</span>
              <span>Cocina Full OH</span>
            </div>
            {previewRows.map((row, index) => (
              <div className="sculpture-row" key={`${row.values.join("-")}-${index}`}>
                <span>{row.group || "-"}</span>
                <span>{row.record.itemName || row.values[0] || "-"}</span>
                <span>{row.record.unit || row.values[1] || "-"}</span>
                <span>{row.record.size || row.values[2] || "-"}</span>
                <span>{row.record.cocinaIn || row.values[3] || "-"}</span>
                <span>{row.record.cocinaFullOH || row.values[4] || "-"}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="module-grid">
          <div className="panel report-panel" id="reports">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Bandeja del modulo 1</p>
                <h2>Reportes en revision</h2>
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
                    <small>{report.audit} - {report.updated}</small>
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
                <small>{reservation.provider} - {reservation.passengers} pasajeros - vence {reservation.due}</small>
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

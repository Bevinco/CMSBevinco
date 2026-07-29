import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  BarChart3,
  Bot,
  Building2,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Cloud,
  Database,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  LayoutDashboard,
  ListChecks,
  Lock,
  LogOut,
  Mail,
  Paperclip,
  Moon,
  PencilLine,
  Plus,
  Printer,
  RefreshCw,
  Send,
  Sun,
  TrendingDown,
  TrendingUp,
  Trash2,
  BookOpenCheck,
  Upload,
  Users,
  ShoppingCart,
  X,
} from "lucide-react";
import "./styles.css";

type ReportStatus = "Borrador" | "Listo para revisar" | "Enviado";

// Estados del flujo de trabajo del equipo (tablero del inicio, correo 17-jul).
const WORKFLOW_STATES = [
  "Falta Información",
  "En Proceso",
  "Comentarios Escritos",
  "Gráficos Actualizados",
  "Listo para el Reporte",
] as const;
const CLICKUP_CALENDAR_URL = "https://app.clickup.com/31025999/v/c/xjuuf-5994";
const WORKFLOW_CARDS_PER_PAGE = 4;
// Columnas del tablero del inicio: cada una matchea el estado REAL de la
// tarea en ClickUp (con o sin tildes), que es la fuente de verdad del equipo.
// La lista "Auditorias Chile" tiene NUEVE estados, no cinco. El orden sigue el
// orderindex de ClickUp. La ultima columna no tiene regex: es el catch-all, y
// ahi cae cualquier estado que el equipo agregue sin avisar.
const WORKFLOW_COLUMNS: Array<{ title: string; match: RegExp | null }> = [
  { title: "Sin Iniciar", match: /inactiv/i },
  { title: "Falta Información", match: /falta.*inf/i },
  { title: "En Proceso", match: /proceso|en curso/i },
  { title: "Gráficos Actualizados", match: /gr[aá]fico/i },
  { title: "Comentarios Escritos", match: /comentario/i },
  // "listo"/"lista para reporte": el nombre exacto varia en la lista de ClickUp.
  { title: "Listo para el Reporte", match: /list[oa]/i },
  { title: "Reporte Enviado", match: /enviad/i },
  { title: "Otros", match: null },
];
// `cerrada` es type "closed" en ClickUp: archivo, no un paso del flujo. Darle
// columna serian decenas de paginas tapando el trabajo real. Se oculta a
// proposito y de forma explicita.
const WORKFLOW_HIDDEN_STATUS = /^cerrad/i;
// La lista arrastra 470 tareas `inactiva` vencidas entre abr-2025 y jun-2025;
// sin ventana, "Sin Iniciar" saldria con 487 tarjetas. Con 30 dias quedan las
// 17 reales y siguen entrando las activas mas viejas.
const WORKFLOW_WINDOW_DAYS = 30;
type AuthStatus = "checking" | "authenticated" | "anonymous";
type WorkStatus = "idle" | "loading" | "ready" | "error";
type ActiveView = "dashboard" | "module1" | "monthly" | "tasks" | "reports" | "criteria" | "users";
type ThemeMode = "light" | "dark";

type Client = {
  id: string;
  name: string;
  accountName?: string;
  moduleName?: string;
  cid: string;
  sculptureCid?: string;
  sculptureBaseUrl?: string;
  area: string;
  recipients: string[];
};

type SculptureUnit = {
  id: string;
  name: string;
  accountName: string;
  moduleName: string;
  cid: string;
  sculptureCid: string;
  area: string;
  baseUrl?: string;
  sculptureBaseUrl?: string;
  hidden?: boolean;
};

type SculpturePeriod = {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  pid?: string;
  sculpturePid?: string;
};

type Period = {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  pid?: string;
  sculpturePid?: string;
};

type HistoryPoint = {
  periodId: string;
  label: string;
  revenue: number;
  costPercent: number;
  varianceAmount: number;
};

type Report = {
  id: string;
  clientId: string;
  periodId: string;
  status: ReportStatus;
  workflowState?: string;
  updatedAt: string;
  client?: Client;
  period?: Period;
  history: HistoryPoint[];
  summary: {
    revenue: number;
    costPercent: number;
    variancePercent: number;
    varianceAmount: number;
    usedCost?: number;
    idealCostPercent?: number;
  };
  categoryVariances: Array<{ category: string; amount: number; percent: number }>;
  familyVariances?: Array<{ family: string; amount: number }>;
  topProducts: Array<{ name: string; category: string; varianceAmount: number; variancePercent: number }>;
  purchaseSuggestions: Array<{ item: string; provider: string; stock: string; suggested: string; note: string }>;
  analysis?: {
    bestOfWeek?: string[];
    weeklyChallenges?: string[];
    stockEfficiency?: string[];
    criteriaApplied?: string[];
    agentNotes?: string[];
  };
  comments: string;
  emailDraft: string;
  isAccumulated?: boolean;
  backfill?: boolean;
  monthly?: boolean;
  emailLog?: { sentAt: string; recipients: string[]; subject: string };
  chat?: Array<{ role: "user" | "assistant"; content: string }>;
  includedPeriods?: Array<{ id: string; label: string; startsAt: string; endsAt: string }>;
  clickupTask?: {
    id?: string;
    url?: string;
    name?: string;
    status?: string;
    listId?: string;
    authSource?: string;
    createdAt?: string;
  };
  sourceStatus: Record<string, string>;
};

type CriteriaDocument = {
  id: string;
  name: string;
  type: string;
  text: string;
  size: number;
  uploadedAt: string;
  source?: string;
  category?: string;
  clientId?: string;
  clientName?: string;
};

type BackupStatus = {
  configured: boolean;
  restored: boolean;
  lastOkAt: string;
  lastError: string;
};

type BootstrapPayload = {
  backupStatus?: BackupStatus;
  clients: Client[];
  periods: Period[];
  criteriaDocuments: CriteriaDocument[];
  reports: Report[];
  selectedReport: Report | null;
};

type SyncResults = Record<string, { error?: string; rowsCount?: number; endpoint?: string; cmd?: string; attempts?: Array<{ endpoint?: string; status?: number; rowsCount?: number; error?: string }> }>;

type AccumulatedReport = {
  id: string;
  clientId: string;
  isAccumulated: true;
  client?: Client;
  period: Period;
  includedPeriods: Array<{ id: string; label: string; startsAt: string; endsAt: string }>;
  summary: Report["summary"];
  categoryVariances: Report["categoryVariances"];
  topProducts: Report["topProducts"];
  purchaseSuggestions: Report["purchaseSuggestions"];
  sourceStatus?: Record<string, string>;
};

type SculptureQueryPayload = BootstrapPayload & {
  queriedReports?: Report[];
  accumulatedReport?: AccumulatedReport | null;
  syncResultsByPeriod?: Record<string, SyncResults>;
};

type ClickupStatus = {
  configured: boolean;
  authSource: string;
  listIdConfigured: boolean;
  connected: boolean;
  user?: { username?: string; email?: string } | null;
  error?: string;
};

function summarizeSculptureSync(syncResultsByPeriod: SculptureQueryPayload["syncResultsByPeriod"]) {
  const results = Object.values(syncResultsByPeriod || {}).flatMap((periodResults) => Object.values(periodResults || {}));
  const rowsCount = results.reduce((sum, result) => sum + (Number(result.rowsCount) || 0), 0);
  const errors = results.filter((result) => result.error);
  const emptySources = results.filter((result) => !result.error && !(Number(result.rowsCount) || 0));
  const endpoints = Array.from(new Set(results.map((result) => result.endpoint).filter(Boolean))).slice(0, 3);

  return { rowsCount, errors, emptySources, endpoints };
}

type ClickupTask = {
  id: string;
  customId?: string;
  name: string;
  url?: string;
  status: string;
  statusColor?: string;
  assignees: Array<{ id?: string; username?: string; email?: string; initials?: string; color?: string }>;
  dueDate?: number | null;
  tags: string[];
  tagDetails?: Array<{ name: string; bg?: string; fg?: string }>;
  subtasks: number;
  dateUpdated?: number | null;
};

type ClickupMember = { id?: number; username?: string; email?: string; initials?: string; color?: string };
type ClickupListStatus = { id?: string; status: string; color?: string; type?: string };
type ClickupMeta = {
  list?: { id?: string; name?: string; statuses?: ClickupListStatus[] };
  members: ClickupMember[];
  importantStatuses: string[];
  defaultTaskStatus: string;
};

type CmsUser = {
  id: string;
  name: string;
  email: string;
  role: "Superadmin" | "Administrador" | "Operaciones" | "Usuario" | string;
  presence?: string;
  permissions: string[];
  source?: "env" | string;
  createdAt?: string;
  updatedAt?: string;
};

const userPermissionOptions = [
  { id: "dashboard", label: "Inicio" },
  { id: "module1", label: "Reportes semanales" },
  { id: "tasks", label: "Pendientes" },
  { id: "reports", label: "Historial" },
  { id: "criteria", label: "Criterios" },
  { id: "users", label: "Usuarios" },
];

const roleOptions = ["Usuario", "Operaciones", "Administrador", "Superadmin"];

const presenceOptions = [
  { id: "disponible", label: "Disponible" },
  { id: "ausente", label: "Ausente" },
  { id: "ocupado", label: "Ocupado" },
  { id: "no-molestar", label: "No molestar" },
];

function emptyUserForm() {
  return {
    id: "",
    name: "",
    email: "",
    password: "",
    role: "Usuario",
    permissions: ["dashboard", "module1", "tasks", "reports"],
  };
}

function userCanAccess(user: Pick<CmsUser, "role" | "permissions"> | null, permission: ActiveView) {
  if (!user) return true;
  if (user.role === "Superadmin") return true;
  return user.permissions?.includes(permission);
}

function isSystemUser(user: CmsUser) {
  return user.id === "env-superadmin" || user.source === "env";
}

// Los detalles tecnicos (CSV manual, OAuth, CID, diagnosticos de conexion)
// solo se muestran a roles administradores; el resto ve la vista de negocio.
function isAdminUser(user: CmsUser | null) {
  if (!user) return true;
  return user.role === "Superadmin" || user.role === "Administrador";
}

const sourceLabels: Record<string, string> = {
  varianceDetailed: "Variance detailed",
  varianceSummary: "Variance summary",
  intelipar: "Intelipar",
};
const tasksPerColumn = 5;

function clientAccountLabel(client?: Client | null) {
  if (!client) return "Sin cliente";
  if (client.accountName) return client.accountName;
  return client.name.split(/\s[-·]\s/)[0] || client.name;
}

function clientUnitLabel(client?: Client | null) {
  if (!client) return "Sin unidad";
  if (client.moduleName) return client.moduleName;
  if (client.name.includes(" - ")) return client.name.split(" - ").slice(1).join(" - ");
  if (client.name.includes(" · ")) return client.name.split(" · ").slice(1).join(" · ");
  return client.area || client.name;
}

function clientDisplayName(client: Client) {
  const account = clientAccountLabel(client);
  const unit = clientUnitLabel(client);
  return account && unit && account !== unit ? `${account} · ${unit}` : client.name;
}

function syncStatusMessage(syncResults: SyncResults = {}) {
  const entries = Object.entries(syncResults);
  if (!entries.length) return "";

  const synced = entries.filter(([, result]) => !result.error).length;
  const failed = entries
    .filter(([, result]) => result.error)
    .map(([source]) => sourceLabels[source] || source);

  return failed.length
    ? `Se actualizaron ${synced} de ${entries.length} datos. Por revisar: ${failed.join(", ")}.`
    : "Datos de la auditoría actualizados correctamente.";
}

function money(value: number) {
  return new Intl.NumberFormat("es-CL", {
    currency: "CLP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value || 0);
}

function shortDate(timestamp?: number | null) {
  if (!timestamp) return "Sin fecha";
  return new Intl.DateTimeFormat("es-CL", { day: "2-digit", month: "short" }).format(new Date(timestamp));
}

function monthFromPeriod(period?: Period | SculpturePeriod | null) {
  return (period?.startsAt || period?.endsAt || "").slice(0, 7);
}

// Columna del tablero para un reporte: manda el estado manual si existe;
// si no, se deriva del avance real del reporte.
function workflowStateFor(report: Report): string {
  if (report.workflowState && WORKFLOW_STATES.includes(report.workflowState as (typeof WORKFLOW_STATES)[number])) {
    return report.workflowState;
  }
  if (!report.summary?.revenue) return "Falta Información";
  if (report.status === "Listo para revisar") return "Listo para el Reporte";
  if ((report.comments || "").trim()) return "Comentarios Escritos";
  return "En Proceso";
}

function statusClass(status: ReportStatus) {
  if (status === "Enviado") return "pill success";
  if (status === "Listo para revisar") return "pill warning";
  return "pill neutral";
}

async function readJson<T>(response: Response): Promise<T> {
  // Sesion vencida: avisar a la app para volver al login en vez de dejar la
  // pantalla muda (periodos que no cargan, PDFs que no abren, etc.).
  if (response.status === 401) {
    window.dispatchEvent(new Event("bevinco:unauthorized"));
  }
  const rawPayload = await response.text();
  let payload: { error?: string; message?: string } = {};

  if (rawPayload) {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      // Respuesta no-JSON (pagina de error HTML): nunca mostrarla cruda.
      payload = {
        error: response.ok
          ? "Respuesta inesperada del servidor."
          : `Error del servidor (${response.status}). Intenta de nuevo en unos segundos.`,
      };
    }
  }

  if (!response.ok) {
    throw new Error(payload.error || payload.message || `La solicitud fallo (${response.status}).`);
  }
  return payload as T;
}

// Resalta montos ($1.234.567) y porcentajes ((21.1%)) dentro del texto del
// analisis: verde para positivos, rojo para negativos.
function highlightFigures(text: string) {
  const parts = String(text).split(/(\$\s?-?[\d.,]+|\(-?\d+(?:[.,]\d+)?%\))/g);
  return parts.map((part, index) => {
    const isMoney = /^\$\s?-?[\d.,]+$/.test(part);
    const isPercent = /^\(-?\d+(?:[.,]\d+)?%\)$/.test(part);
    if (!isMoney && !isPercent) return <span key={index}>{part}</span>;
    const negative = part.includes("-");
    return (
      <b key={index} className={`fig ${negative ? "fig-neg" : "fig-pos"}`}>
        {part}
      </b>
    );
  });
}

const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const MONTH_FULL = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

function MonthPicker({ value, onChange, placeholder = "Elegir mes" }: { value: string; onChange: (next: string) => void; placeholder?: string }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => Number((value || "").slice(0, 4)) || new Date().getFullYear());
  const selectedYear = Number((value || "").slice(0, 4)) || null;
  const selectedMonth = Number((value || "").slice(5, 7)) || null;

  useEffect(() => {
    if (open && selectedYear) setViewYear(selectedYear);
  }, [open, selectedYear]);

  const monthName = selectedMonth ? MONTH_FULL[selectedMonth - 1] : "";
  const display = selectedYear && selectedMonth
    ? `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} de ${selectedYear}`
    : placeholder;

  return (
    <div className="month-picker">
      <button className={`month-picker-trigger ${value ? "" : "is-empty"}`} type="button" onClick={() => setOpen((current) => !current)}>
        <CalendarDays size={16} />
        <span>{display}</span>
      </button>
      {open ? (
        <>
          <div className="month-picker-backdrop" onClick={() => setOpen(false)} />
          <div className="month-picker-pop" role="dialog" aria-label="Elegir mes">
            <div className="month-picker-year">
              <button type="button" aria-label="Año anterior" onClick={() => setViewYear((year) => year - 1)}><ChevronLeft size={16} /></button>
              <strong>{viewYear}</strong>
              <button type="button" aria-label="Año siguiente" onClick={() => setViewYear((year) => year + 1)}><ChevronRight size={16} /></button>
            </div>
            <div className="month-picker-grid">
              {MONTH_LABELS.map((label, index) => {
                const isSelected = selectedYear === viewYear && selectedMonth === index + 1;
                const now = new Date();
                const isCurrent = now.getFullYear() === viewYear && now.getMonth() === index;
                return (
                  <button
                    className={`month-cell ${isSelected ? "selected" : ""} ${isCurrent ? "current" : ""}`}
                    key={label}
                    type="button"
                    onClick={() => {
                      onChange(`${viewYear}-${String(index + 1).padStart(2, "0")}`);
                      setOpen(false);
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function SculptureMark() {
  return <img className="brand-logo" src="/logo.png" alt="Sculpture Hospitality" />;
}

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submitLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      await readJson(
        await fetch("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        }),
      );
      onLogin();
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Error desconocido.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand login-brand">
          <SculptureMark />
          <div>
            <strong>Sculpture Hospitality</strong>
            <span>Bevinco CMS</span>
          </div>
        </div>
        <div>
          <p className="eyebrow">Acceso interno</p>
          <h1>Reportes semanales sin fricción</h1>
        </div>
        <form className="login-form" onSubmit={submitLogin}>
          <label>
            Usuario
            <input autoComplete="username" onChange={(event) => setUsername(event.target.value)} required type="text" value={username} />
          </label>
          <label>
            Contraseña
            <input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} />
          </label>
          {error ? <p className="login-error">{error}</p> : null}
          <button className="primary-button" disabled={submitting} type="submit">
            <Lock size={17} /> {submitting ? "Entrando" : "Entrar"}
          </button>
        </form>
      </section>
    </main>
  );
}

function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("checking");
  const [currentUser, setCurrentUser] = useState("");
  const [currentUserInfo, setCurrentUserInfo] = useState<CmsUser | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => (localStorage.getItem("bevinco-theme") === "dark" ? "dark" : "light"));
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [presence, setPresence] = useState(() => localStorage.getItem("bevinco-presence") || "disponible");
  const [reportSearch, setReportSearch] = useState("");
  const [reportStatusFilter, setReportStatusFilter] = useState("Todos");
  const [reportPage, setReportPage] = useState(0);
  const [workflowPages, setWorkflowPages] = useState<Record<string, number>>({});
  const [calendarWeekOffset, setCalendarWeekOffset] = useState(0);
  const [calendarTasks, setCalendarTasks] = useState<ClickupTask[]>([]);
  const [workStatus, setWorkStatus] = useState<WorkStatus>("idle");
  const [error, setError] = useState("");
  const [clients, setClients] = useState<Client[]>([]);
  const [periods, setPeriods] = useState<Period[]>([]);
  const [reports, setReports] = useState<Report[]>([]);
  const [selectedClientId, setSelectedClientId] = useState("");
  const [selectedPeriodId, setSelectedPeriodId] = useState("");
  const [selectedReport, setSelectedReport] = useState<Report | null>(null);
  const [commentsDraft, setCommentsDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [activeView, setActiveView] = useState<ActiveView>("dashboard");
  const [criteriaDocuments, setCriteriaDocuments] = useState<CriteriaDocument[]>([]);
  const [editingCriteria, setEditingCriteria] = useState<CriteriaDocument | null>(null);
  const [bulkBlock, setBulkBlock] = useState({ title: "", text: "", target: "all", clientId: "" });
  const [bulkSaving, setBulkSaving] = useState(false);
  const [criteriaClientId, setCriteriaClientId] = useState("");
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "user" | "assistant"; content: string }>>([]);
  const [monthlyMonth, setMonthlyMonth] = useState("");
  const [monthlySelectedIds, setMonthlySelectedIds] = useState<string[]>([]);
  const [monthlyReport, setMonthlyReport] = useState<Report | null>(null);
  const [monthlyGenerating, setMonthlyGenerating] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState<string[]>([]);
  const [emailRecipientInput, setEmailRecipientInput] = useState("");
  const [emailSubject, setEmailSubject] = useState("");
  const [emailSending, setEmailSending] = useState(false);
  const [reportTab, setReportTab] = useState<"chat" | "send">("chat");
  const [chatFiles, setChatFiles] = useState<File[]>([]);
  const [selectedCriteriaFiles, setSelectedCriteriaFiles] = useState<File[]>([]);
  const [sculptureUnits, setSculptureUnits] = useState<SculptureUnit[]>([]);
  const [sculpturePeriods, setSculpturePeriods] = useState<SculpturePeriod[]>([]);
  const [selectedSculptureUnitId, setSelectedSculptureUnitId] = useState("");
  const [sculptureDirectoryLoaded, setSculptureDirectoryLoaded] = useState(false);
  const [accumulatedReport, setAccumulatedReport] = useState<AccumulatedReport | null>(null);
  const [clientPeriods, setClientPeriods] = useState<SculpturePeriod[]>([]);
  const [clientPeriodsLoading, setClientPeriodsLoading] = useState(false);
  const periodsRequestRef = useRef(0);
  const [clickupStatus, setClickupStatus] = useState<ClickupStatus | null>(null);
  const [clickupTasks, setClickupTasks] = useState<ClickupTask[]>([]);
  const [clickupMeta, setClickupMeta] = useState<ClickupMeta>({ members: [], importantStatuses: [], defaultTaskStatus: "LISTO PARA REPORTE" });
  const [clickupPage, setClickupPage] = useState(0);
  const [clickupHasMore, setClickupHasMore] = useState(false);
  const [clickupColumnPages, setClickupColumnPages] = useState<Record<string, number>>({});
  const [clickupStatusFilter, setClickupStatusFilter] = useState("important");
  const [cmsUsers, setCmsUsers] = useState<CmsUser[]>([]);
  const [userModalOpen, setUserModalOpen] = useState(false);
  const [editingUserId, setEditingUserId] = useState("");
  const [userForm, setUserForm] = useState(emptyUserForm());
  const [newPending, setNewPending] = useState({
    name: "",
    description: "",
    dueDate: "",
    dueTime: "",
    status: "LISTO PARA REPORTE",
    assignee: "",
    priority: "3",
  });
  const [newUnit, setNewUnit] = useState({
    accountName: "",
    moduleName: "",
    area: "Food",
    sculptureCid: "",
    recipients: "",
  });

  async function checkSession() {
    try {
      const payload = await readJson<{ authenticated: boolean; user: CmsUser & { username?: string } | null }>(
        await fetch("/api/auth/me"),
      );

      if (payload.authenticated) {
        setCurrentUser(payload.user?.name || payload.user?.username || payload.user?.email || "");
        setCurrentUserInfo(payload.user || null);
        setAuthStatus("authenticated");
        return;
      }
    } catch {
      setCurrentUser("");
    }

    setAuthStatus("anonymous");
  }

  async function loadUsers() {
    try {
      const payload = await readJson<{ users: CmsUser[] }>(await fetch("/api/users"));
      setCmsUsers(payload.users || []);
    } catch (usersError) {
      setError(usersError instanceof Error ? usersError.message : "No se pudieron cargar los usuarios.");
    }
  }

  function openCreateUserModal() {
    setEditingUserId("");
    setUserForm(emptyUserForm());
    setUserModalOpen(true);
  }

  function openEditUserModal(user: CmsUser) {
    setEditingUserId(user.id);
    setUserForm({
      id: user.id,
      name: user.name || "",
      email: user.email || "",
      password: "",
      role: user.role || "Usuario",
      permissions: user.permissions?.length ? user.permissions : ["dashboard"],
    });
    setUserModalOpen(true);
  }

  async function saveUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWorkStatus("loading");
    setError("");

    try {
      const body = {
        name: userForm.name,
        email: userForm.email,
        password: userForm.password,
        role: userForm.role,
        permissions: userForm.permissions,
      };
      const endpoint = editingUserId ? `/api/users/${editingUserId}` : "/api/users";
      const method = editingUserId ? "PATCH" : "POST";
      const payload = await readJson<{ users: CmsUser[] }>(
        await fetch(endpoint, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(editingUserId && !userForm.password ? { ...body, password: undefined } : body),
        }),
      );
      setCmsUsers(payload.users || []);
      setUserModalOpen(false);
      setEditingUserId("");
      setUserForm(emptyUserForm());
      setWorkStatus("ready");
    } catch (userError) {
      setError(userError instanceof Error ? userError.message : "No se pudo guardar el usuario.");
      setWorkStatus("error");
    }
  }

  async function deleteUser(userId: string) {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<{ users: CmsUser[] }>(await fetch(`/api/users/${userId}`, { method: "DELETE" }));
      setCmsUsers(payload.users || []);
      setWorkStatus("ready");
    } catch (userError) {
      setError(userError instanceof Error ? userError.message : "No se pudo eliminar el usuario.");
      setWorkStatus("error");
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setCurrentUser("");
    setCurrentUserInfo(null);
    setAuthStatus("anonymous");
    setSelectedReport(null);
  }

  function navigateTo(view: ActiveView) {
    setError("");
    setActiveView(view);
  }

  function applyBootstrapPayload(payload: BootstrapPayload) {
    if (payload.backupStatus) setBackupStatus(payload.backupStatus);
    setClients(payload.clients);
    setPeriods(payload.periods);
    setReports(payload.reports);
    setCriteriaDocuments(payload.criteriaDocuments || []);
    const report = payload.selectedReport;
    setSelectedReport(report);
    setSelectedClientId(report?.clientId || payload.clients[0]?.id || "");
    setSelectedPeriodId(report?.periodId || payload.periods[0]?.id || "");
    setCommentsDraft(report?.comments || "");
    setEmailDraft(report?.emailDraft || "");
  }

  async function loadModule() {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<BootstrapPayload>(await fetch("/api/module1/bootstrap"));
      applyBootstrapPayload(payload);
      setWorkStatus("ready");
    } catch (moduleError) {
      setError(moduleError instanceof Error ? moduleError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function loadClickupStatus() {
    try {
      const status = await readJson<ClickupStatus>(await fetch("/api/clickup/status"));
      setClickupStatus(status);
    } catch (statusError) {
      setClickupStatus({
        configured: false,
        authSource: "error",
        listIdConfigured: false,
        connected: false,
        error: statusError instanceof Error ? statusError.message : "Error desconocido.",
      });
    }
  }

  async function loadClickupMeta() {
    try {
      const meta = await readJson<ClickupMeta>(await fetch("/api/clickup/meta"));
      setClickupMeta(meta);
      setNewPending((current) => ({ ...current, status: current.status || meta.defaultTaskStatus || "LISTO PARA REPORTE" }));
    } catch (metaError) {
      setClickupMeta({ members: [], importantStatuses: [], defaultTaskStatus: "LISTO PARA REPORTE" });
      setError(metaError instanceof Error ? metaError.message : "No se pudo cargar la configuracion de ClickUp.");
    }
  }

  // El calendario necesita TODAS las tareas con fecha (cualquier estado),
  // no solo las del filtro del tablero de pendientes.
  async function loadCalendarTasks() {
    try {
      const payload = await readJson<{ tasks: ClickupTask[] }>(
        await fetch("/api/clickup/tasks?status=all"),
      );
      setCalendarTasks(payload.tasks || []);
    } catch {
      // Sin ClickUp el calendario simplemente queda vacio.
    }
  }

  async function loadClickupTasks(page = clickupPage, status = clickupStatusFilter) {
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (status && status !== "important") params.set("status", status);
      const payload = await readJson<{ tasks: ClickupTask[]; hasMore?: boolean; page?: number }>(
        await fetch(`/api/clickup/tasks?${params}`),
      );
      setClickupTasks(payload.tasks || []);
      setClickupHasMore(Boolean(payload.hasMore));
      setClickupPage(payload.page || page);
      setClickupColumnPages({});
    } catch (tasksError) {
      setClickupTasks([]);
      setError(tasksError instanceof Error ? tasksError.message : "No se pudieron cargar las tareas de ClickUp.");
    }
  }

  async function createManualClickupTask(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newPending.name.trim()) {
      setError("El pendiente necesita un nombre.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Creando pendiente en ClickUp...");

    try {
      const dueDate = newPending.dueDate
        ? `${newPending.dueDate}T${newPending.dueTime || "18:00"}`
        : "";
      await readJson<{ task: ClickupTask }>(
        await fetch("/api/clickup/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: newPending.name,
            description: newPending.description,
            status: newPending.status,
            dueDate,
            dueDateTime: Boolean(newPending.dueTime),
            priority: Number(newPending.priority),
            assignees: newPending.assignee ? [newPending.assignee] : [],
            tags: ["bevinco", "operacion"],
          }),
        }),
      );
      setNewPending({
        name: "",
        description: "",
        dueDate: "",
        dueTime: "",
        status: clickupMeta.defaultTaskStatus || "LISTO PARA REPORTE",
        assignee: "",
        priority: "3",
      });
      await loadClickupTasks(0, clickupStatusFilter);
      setError("Pendiente creado en ClickUp.");
      setWorkStatus("ready");
    } catch (taskError) {
      setError(taskError instanceof Error ? taskError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function importSamples() {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<BootstrapPayload>(
        await fetch("/api/module1/import-samples", { method: "POST" }),
      );
      applyBootstrapPayload(payload);
      setWorkStatus("ready");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function createReportingUnit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const accountName = newUnit.accountName.trim();
    const moduleName = newUnit.moduleName.trim();
    const sculptureCid = newUnit.sculptureCid.trim();

    if (!accountName || !moduleName) {
      setError("Completa cliente y unidad para crear una nueva unidad de reporte.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Creando unidad de reporte...");

    try {
      const payload = await readJson<{ client: Client; clients: Client[] }>(
        await fetch("/api/module1/clients", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            accountName,
            moduleName,
            name: `${accountName} - ${moduleName}`,
            cid: sculptureCid || `${accountName}-${moduleName}`,
            sculptureCid,
            area: newUnit.area,
            recipients: newUnit.recipients
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          }),
        }),
      );
      setClients(payload.clients);
      setSelectedClientId(payload.client.id);
      setNewUnit({ accountName, moduleName: "", area: "Food", sculptureCid: "", recipients: "" });
      await loadSelectedReport(payload.client.id, selectedPeriodId);
      setError(`Unidad creada: ${clientDisplayName(payload.client)}. Ya puedes generar su reporte.`);
      setWorkStatus("ready");
    } catch (unitError) {
      setError(unitError instanceof Error ? unitError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function toggleUnitVisibility(unit: SculptureUnit) {
    const willHide = !unit.hidden;
    try {
      await readJson(
        await fetch("/api/module1/sculpture-units/visibility", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sculptureCid: unit.sculptureCid || unit.cid, area: unit.area, hidden: willHide }),
        }),
      );
      setSculptureUnits((current) =>
        current.map((item) =>
          (item.sculptureCid || item.cid) === (unit.sculptureCid || unit.cid) && item.area === unit.area
            ? { ...item, hidden: willHide }
            : item,
        ),
      );
      if (willHide && selectedSculptureUnitId === unit.id) setSelectedSculptureUnitId("");
      setError(willHide ? `"${unit.name}" quedó oculto del listado.` : `"${unit.name}" vuelve a estar disponible.`);
      setWorkStatus("ready");
    } catch (visibilityError) {
      setError(visibilityError instanceof Error ? visibilityError.message : "No se pudo actualizar el restaurante.");
      setWorkStatus("error");
    }
  }

  async function deleteClient(clientId: string) {
    const target = clients.find((client) => client.id === clientId);
    if (!target) return;
    if (!window.confirm(`Eliminar "${clientDisplayName(target)}" del CMS? Se quitaran tambien sus reportes guardados.`)) {
      return;
    }

    setWorkStatus("loading");
    setError(`Eliminando ${clientDisplayName(target)}...`);

    try {
      const payload = await readJson<{ removedClientId: string; removedReports: number; clients: Client[]; reports: Report[] }>(
        await fetch(`/api/module1/clients/${clientId}`, { method: "DELETE" }),
      );
      setClients(payload.clients);
      setReports(payload.reports);
      if (selectedClientId === clientId) {
        setSelectedClientId(payload.clients[0]?.id || "");
        setSelectedReport(null);
      }
      setError(`Restaurante eliminado. Se quitaron ${payload.removedReports} reporte(s) asociado(s).`);
      setWorkStatus("ready");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "No se pudo eliminar el restaurante.");
      setWorkStatus("error");
    }
  }

  async function loadSculptureUnits({ quiet = false } = {}) {
    setWorkStatus("loading");
    if (!quiet) setError("Cargando restaurantes y periodos desde Sculpture...");

    try {
      const payload = await readJson<{ units: SculptureUnit[]; periods?: SculpturePeriod[]; errors?: Array<{ area: string; path: string; error: string }> }>(
        await fetch("/api/module1/sculpture-units"),
      );
      const units = payload.units || [];
      const periodsFromSculpture = payload.periods || [];
      setSculptureUnits(units);
      setSculpturePeriods(periodsFromSculpture);
      setSelectedSculptureUnitId((current) => current || units[0]?.id || "");
      setSculptureDirectoryLoaded(true);
      if (!quiet || !units.length) {
        setError(
          units.length
            ? `Lista actualizada: ${units.length} restaurante(s) y ${periodsFromSculpture.length} periodo(s) disponibles.`
            : isAdminUser(currentUserInfo)
              ? "No se detectaron restaurantes en Sculpture. Revisa credenciales, cookie o permisos de la cuenta."
              : "No pudimos traer la lista de restaurantes. Avisa al administrador.",
        );
      }
      setWorkStatus(units.length ? "ready" : "error");
    } catch (unitError) {
      setSculptureUnits([]);
      setSculpturePeriods([]);
      setSelectedSculptureUnitId("");
      setSculptureDirectoryLoaded(true);
      setError(unitError instanceof Error ? unitError.message : "No se pudo leer la lista de Sculpture.");
      setWorkStatus("error");
    }
  }

  function ensureSculptureDirectory() {
    if (sculptureDirectoryLoaded || workStatus === "loading") return;
    loadSculptureUnits({ quiet: true });
  }

  async function importSelectedSculptureUnit(unitId = selectedSculptureUnitId) {
    const unit = sculptureUnits.find((item) => item.id === unitId);
    if (!unit) {
      setError("Primero busca y selecciona una unidad de Sculpture.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Agregando unidad de Sculpture al módulo...");

    try {
      const payload = await readJson<{ client: Client; clients: Client[]; selectedReport: Report; reports: Report[] }>(
        await fetch("/api/module1/sculpture-units/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...unit, periodId: selectedPeriodId }),
        }),
      );
      setClients(payload.clients);
      setReports(payload.reports);
      setSelectedClientId(payload.client.id);
      setSelectedReport(payload.selectedReport);
      setSelectedPeriodId(payload.selectedReport.periodId);
      setCommentsDraft(payload.selectedReport.comments || "");
      setEmailDraft(payload.selectedReport.emailDraft || "");
      setError(`Unidad agregada: ${clientDisplayName(payload.client)}. Ya puedes generar su reporte.`);
      setWorkStatus("ready");
    } catch (unitError) {
      setError(unitError instanceof Error ? unitError.message : "No se pudo agregar la unidad de Sculpture.");
      setWorkStatus("error");
    }
  }

  async function loadClientPeriods(unit: { sculptureCid?: string; cid?: string; area?: string; baseUrl?: string; sculptureBaseUrl?: string } | null) {
    const requestId = ++periodsRequestRef.current;
    const isCurrent = () => requestId === periodsRequestRef.current;
    const cid = unit?.sculptureCid || unit?.cid || "";

    if (!cid || !/^\d+$/.test(String(cid))) {
      if (isCurrent()) setClientPeriods([]);
      return;
    }

    setClientPeriodsLoading(true);
    try {
      const params = new URLSearchParams({ cid: String(cid), area: unit?.area || "" });
      if (unit?.baseUrl || unit?.sculptureBaseUrl) params.set("baseUrl", unit.baseUrl || unit.sculptureBaseUrl || "");
      const payload = await readJson<{ periods: SculpturePeriod[] }>(
        await fetch(`/api/module1/sculpture-units/periods?${params.toString()}`),
      );
      if (!isCurrent()) return;
      const periods = payload.periods || [];
      setClientPeriods(periods);
      setSelectedPeriodId("");
      if (!periods.length) {
        setError("Este restaurante no tiene periodos de auditoría disponibles en Sculpture.");
      }
    } catch (periodsError) {
      if (!isCurrent()) return;
      setClientPeriods([]);
      setError(
        periodsError instanceof Error && isAdminUser(currentUserInfo)
          ? `No se pudieron traer los periodos: ${periodsError.message}`
          : "No se pudieron traer los periodos de este restaurante. Intenta de nuevo en unos segundos.",
      );
    } finally {
      if (isCurrent()) setClientPeriodsLoading(false);
    }
  }

  async function querySculptureReports() {
    const selectedUnit = sculptureUnits.find((item) => item.id === selectedSculptureUnitId);

    if (!selectedUnit && !selectedClientId) {
      setError("Primero busca y selecciona un restaurante/local de Sculpture.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Trayendo los datos de la auditoría...");

    try {
      const payload = await readJson<SculptureQueryPayload>(
        await fetch("/api/module1/sculpture/query", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            unit: selectedUnit,
            clientId: selectedUnit ? "" : selectedClientId,
            periodId: selectedPeriodId,
            periodIds: selectedPeriodId ? [selectedPeriodId] : [],
            periods: clientPeriods.length ? clientPeriods : sculpturePeriods,
          }),
        }),
      );
      applyBootstrapPayload(payload);
      setAccumulatedReport(payload.accumulatedReport || null);
      const count = payload.queriedReports?.length || 0;
      const syncSummary = summarizeSculptureSync(payload.syncResultsByPeriod);

      if (count && syncSummary.rowsCount) {
        setError(`Listo: ${count} reporte(s) actualizados con los datos de la auditoría.`);
        setWorkStatus("ready");
        return;
      }

      if (isAdminUser(currentUserInfo)) {
        const endpointNote = syncSummary.endpoints.length ? ` Endpoints probados: ${syncSummary.endpoints.join(", ")}.` : "";
        const errorNote = syncSummary.errors.length
          ? ` ${syncSummary.errors.length} fuente(s) fallaron; revisa sesion, credenciales o permisos en Render.`
          : ` Sculpture respondio, pero no devolvio filas para las fuentes del periodo.`;
        setError(`${errorNote}${endpointNote}`);
      } else {
        setError("No pudimos traer los datos de esa semana. Intenta de nuevo en unos minutos o avisa al administrador.");
      }
      setWorkStatus("error");
    } catch (queryError) {
      setError(
        isAdminUser(currentUserInfo) && queryError instanceof Error
          ? queryError.message
          : "No pudimos traer los datos. Intenta de nuevo o avisa al administrador.",
      );
      setWorkStatus("error");
    }
  }

  async function importCriteriaFiles(files = selectedCriteriaFiles) {
    if (!files.length) return;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > 5 * 1024 * 1024) {
      setError("La carga de criterios supera 5 MB. Sube documentos más pequeños o divididos por tema.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Leyendo criterios para alimentar el agente de reportes...");

    try {
      const encodedFiles = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          type: file.type || "text/plain",
          size: file.size,
          text: await file.text(),
        })),
      );
      const payload = await readJson<BootstrapPayload>(
        await fetch("/api/module1/criteria-documents", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            files: encodedFiles,
            clientId: criteriaClientId,
            clientName:
              sculptureUnits.find((unit) => unit.id === criteriaClientId)?.name ||
              clients.find((client) => client.id === criteriaClientId)?.name ||
              "",
          }),
        }),
      );
      applyBootstrapPayload(payload);
      setSelectedCriteriaFiles([]);
      setError("Criterios cargados. El agente los tomara en cuenta al generar los reportes.");
      setWorkStatus("ready");
    } catch (criteriaError) {
      setError(criteriaError instanceof Error ? criteriaError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function saveCriteriaEdit() {
    if (!editingCriteria) return;
    setWorkStatus("loading");
    try {
      const payload = await readJson<{ document: CriteriaDocument; criteriaDocuments: CriteriaDocument[] }>(
        await fetch(`/api/module1/criteria-documents/${editingCriteria.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: editingCriteria.name,
            text: editingCriteria.text,
            clientId: editingCriteria.clientId || "",
            clientName: editingCriteria.clientName || "",
          }),
        }),
      );
      setCriteriaDocuments(payload.criteriaDocuments || []);
      setEditingCriteria(null);
      setError("Criterio actualizado. Los próximos análisis usarán la versión nueva.");
      setWorkStatus("ready");
    } catch (editError) {
      setError(editError instanceof Error ? editError.message : "No se pudo guardar el criterio.");
      setWorkStatus("error");
    }
  }

  async function applyBulkBlock() {
    if (!bulkBlock.title.trim() || !bulkBlock.text.trim() || bulkSaving) return;
    setBulkSaving(true);
    setWorkStatus("loading");
    try {
      const payload = await readJson<{ updated: number; criteriaDocuments: CriteriaDocument[] }>(
        await fetch("/api/module1/criteria-documents/bulk-block", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bulkBlock),
        }),
      );
      setCriteriaDocuments(payload.criteriaDocuments || []);
      setBulkBlock((current) => ({ ...current, title: "", text: "" }));
      setError(`Bloque aplicado a ${payload.updated} criterio(s). Re-aplicarlo con el mismo título lo actualiza sin duplicar.`);
      setWorkStatus("ready");
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : "No se pudo aplicar el bloque.");
      setWorkStatus("error");
    } finally {
      setBulkSaving(false);
    }
  }

  async function deleteCriteriaDocument(documentId: string) {
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<BootstrapPayload>(
        await fetch(`/api/module1/criteria-documents/${documentId}`, { method: "DELETE" }),
      );
      applyBootstrapPayload(payload);
      setError("Criterio eliminado. El agente recalculará el análisis con la biblioteca actual.");
      setWorkStatus("ready");
    } catch (criteriaError) {
      setError(criteriaError instanceof Error ? criteriaError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function loadSelectedReport(clientId = selectedClientId, periodId = selectedPeriodId) {
    if (!clientId || !periodId) return;
    setWorkStatus("loading");
    setError("Cargando cliente y trayendo informacion desde Sculpture...");

    try {
      const payload = await readJson<Report | { report: Report; syncResults: SyncResults }>(
        await fetch(`/api/module1/reports/current?clientId=${encodeURIComponent(clientId)}&periodId=${encodeURIComponent(periodId)}`),
      );
      const report = "report" in payload ? payload.report : payload;
      const syncResults = "syncResults" in payload ? payload.syncResults : {};
      setSelectedReport(report);
      setCommentsDraft(report.comments || "");
      setEmailDraft(report.emailDraft || "");
      setReports((current) => {
        const exists = current.some((item) => item.id === report.id);
        return exists ? current.map((item) => (item.id === report.id ? report : item)) : [report, ...current];
      });
      setError(syncStatusMessage(syncResults));
      setWorkStatus("ready");
    } catch (reportError) {
      setError(reportError instanceof Error ? reportError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function syncReport() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("Intentando traer Variance e Intelipar desde Sculpture...");

    try {
      const payload = await readJson<{ report: Report; syncResults: SyncResults }>(
        await fetch("/api/module1/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clientId: selectedReport.clientId, periodId: selectedReport.periodId }),
        }),
      );
      setSelectedReport(payload.report);
      setCommentsDraft(payload.report.comments || "");
      setEmailDraft(payload.report.emailDraft || "");
      setReports((current) => current.map((item) => (item.id === payload.report.id ? payload.report : item)));
      setError(syncStatusMessage(payload.syncResults));
      setWorkStatus("ready");
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  // Si la respuesta del agente trae las secciones del reporte (LO MEJOR /
  // DESAFIOS / EFICIENCIA / DIAGNOSTICO), se reparte cada bullet en la
  // seccion correspondiente del analisis; el texto sin secciones va al
  // resumen ejecutivo como antes.
  function parseAnalysisFromText(text: string) {
    const headings: Array<[RegExp, keyof NonNullable<Report["analysis"]>]> = [
      [/LO MEJOR DE (LA SEMANA|EL MES|ESTE PERIODO)/i, "bestOfWeek"],
      [/DESAF[ÍI]OS (DE LA SEMANA|DEL MES|DEL PERIODO)/i, "weeklyChallenges"],
      [/EFICIENCIA DE STOCK/i, "stockEfficiency"],
      [/DIAGN[ÓO]STICO/i, "agentNotes"],
    ];
    const sections: Partial<Record<keyof NonNullable<Report["analysis"]>, string[]>> = {};
    let current: keyof NonNullable<Report["analysis"]> | null = null;
    // El agente a veces responde con guiones y a veces con párrafos sueltos:
    // una línea en blanco separa ítems; sin blanco de por medio es continuación.
    let afterBlank = true;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        afterBlank = true;
        continue;
      }
      const heading = headings.find(([pattern]) => pattern.test(line) && line.length < 70);
      if (heading) {
        current = heading[1];
        if (!sections[current]) sections[current] = [];
        afterBlank = true;
        continue;
      }
      if (!current) {
        afterBlank = false;
        continue;
      }
      const bucket = sections[current]!;
      if (/^[-•–*]\s+/.test(line)) bucket.push(line.replace(/^[-•–*]\s+/, ""));
      else if (afterBlank || !bucket.length) bucket.push(line);
      else bucket[bucket.length - 1] += ` ${line}`;
      afterBlank = false;
    }
    const filled = Object.fromEntries(Object.entries(sections).filter(([, items]) => items && items.length));
    return Object.keys(filled).length ? (filled as Partial<NonNullable<Report["analysis"]>>) : null;
  }

  const [chatLearning, setChatLearning] = useState(false);
  async function learnFromChat() {
    if (!selectedReport || chatLearning || chatMessages.length < 2) return;
    setChatLearning(true);
    setWorkStatus("loading");
    try {
      const payload = await readJson<{ saved: boolean; ruleCount?: number; clientName?: string; message?: string; criteriaDocuments?: CriteriaDocument[] }>(
        await fetch(`/api/module1/reports/${selectedReport.id}/chat/learn`, { method: "POST" }),
      );
      if (payload.criteriaDocuments) setCriteriaDocuments(payload.criteriaDocuments);
      setError(payload.saved
        ? `Memoria actualizada: ${payload.ruleCount} regla(s) guardadas en el criterio de ${payload.clientName}.`
        : payload.message || "La conversación no aporta reglas nuevas.");
      setWorkStatus("ready");
    } catch (learnError) {
      setError(learnError instanceof Error ? learnError.message : "No se pudo guardar el aprendizaje.");
      setWorkStatus("error");
    } finally {
      setChatLearning(false);
    }
  }

  async function applyChatAsSummary(content: string) {
    const parsed = parseAnalysisFromText(content);
    if (!parsed || !selectedReport) {
      setCommentsDraft(content);
      return;
    }
    try {
      await saveReport({
        comments: content,
        analysis: { ...(selectedReport.analysis || {}), ...parsed },
      });
      setError("Resumen aplicado: las secciones del análisis de abajo quedaron actualizadas.");
      setWorkStatus("ready");
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "No se pudo aplicar el resumen.");
      setWorkStatus("error");
    }
  }

  async function saveReport(patch: Partial<Report>) {
    if (!selectedReport) return;

    const updated = await readJson<Report>(
      await fetch(`/api/module1/reports/${selectedReport.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );

    setSelectedReport(updated);
    setReports((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    if (patch.comments !== undefined) setCommentsDraft(updated.comments || "");
    if (patch.emailDraft !== undefined) setEmailDraft(updated.emailDraft || "");
  }

  async function generateMonthlyReport() {
    const selectedUnit = sculptureUnits.find((item) => item.id === selectedSculptureUnitId);
    if ((!selectedUnit && !selectedClientId) || !monthlyMonth || monthlyGenerating) return;

    setMonthlyGenerating(true);
    setError("Acumulando las semanas del mes...");
    setWorkStatus("loading");

    try {
      const payload = await readJson<{ report: Report; reports: Report[] }>(
        await fetch("/api/module1/monthly/generate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            unit: selectedUnit,
            clientId: selectedUnit ? "" : selectedClientId,
            month: monthlyMonth,
            periodIds: monthlySelectedIds,
          }),
        }),
      );
      setMonthlyReport(payload.report);
      setReports(payload.reports);
      setError(`Reporte mensual listo: ${(payload.report.includedPeriods || []).length} semana(s) acumuladas.`);
      setWorkStatus("ready");
    } catch (monthlyError) {
      setError(monthlyError instanceof Error ? monthlyError.message : "No se pudo generar el reporte mensual.");
      setWorkStatus("error");
    } finally {
      setMonthlyGenerating(false);
    }
  }

  async function moveClickupTask(task: ClickupTask, columnTitle: string) {
    const column = WORKFLOW_COLUMNS.find((item) => item.title === columnTitle);
    // Sin regex es la columna catch-all: no es un destino valido.
    if (!column?.match) return;
    // La copia local conserva el estrechamiento de tipo dentro del callback.
    const match = column.match;
    // El nombre exacto del estado lo define la lista de ClickUp.
    const targetStatus = clickupStatusOptions.find((status) => match.test(status)) || columnTitle;
    try {
      const payload = await readJson<{ task: ClickupTask }>(
        await fetch(`/api/clickup/tasks/${task.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: targetStatus }),
        }),
      );
      const updated = payload.task;
      setCalendarTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setClickupTasks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setError(`"${task.name}" movida a ${targetStatus} en ClickUp.`);
      setWorkStatus("ready");
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : "No se pudo mover la tarea en ClickUp.");
      setWorkStatus("error");
    }
  }

  async function setReportWorkflowState(report: Report, state: string) {
    try {
      const updated = await readJson<Report>(
        await fetch(`/api/module1/reports/${report.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workflowState: state }),
        }),
      );
      setReports((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (stateError) {
      setError(stateError instanceof Error ? stateError.message : "No se pudo actualizar el estado.");
      setWorkStatus("error");
    }
  }

  function openMonthlyReport() {
    if (!monthlyReport) return;
    setSelectedClientId(monthlyReport.clientId);
    setSelectedPeriodId(monthlyReport.periodId);
    setSelectedReport(monthlyReport);
    setCommentsDraft(monthlyReport.comments || "");
    setEmailDraft(monthlyReport.emailDraft || "");
    navigateTo("module1");
  }

  function addEmailRecipient(raw?: string) {
    const value = (raw ?? emailRecipientInput).trim().toLowerCase().replace(/[,;]+$/, "");
    if (!value) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setError(`"${value}" no parece un correo válido.`);
      setWorkStatus("error");
      return;
    }
    setEmailRecipients((current) => (current.includes(value) ? current : [...current, value]));
    setEmailRecipientInput("");
  }

  async function sendReportEmail() {
    if (!selectedReport || emailSending) return;
    if (!emailRecipients.length) {
      setError("Agrega al menos un destinatario antes de enviar.");
      setWorkStatus("error");
      return;
    }

    setEmailSending(true);
    setWorkStatus("loading");
    setError("Enviando el reporte por correo...");

    try {
      // Guardar el borrador actual antes de enviar, para que el correo salga con lo editado.
      await readJson(await fetch(`/api/module1/reports/${selectedReport.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comments: commentsDraft, emailDraft }),
      }));
      const payload = await readJson<{ sent: boolean; message?: string; report?: Report }>(
        await fetch(`/api/module1/reports/${selectedReport.id}/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipients: emailRecipients, subject: emailSubject }),
        }),
      );
      if (payload.report) {
        setSelectedReport(payload.report);
        setReports((current) => current.map((item) => (item.id === payload.report!.id ? payload.report! : item)));
      }
      if (payload.sent) {
        setError(`Correo enviado a ${emailRecipients.join(", ")}.`);
        setWorkStatus("ready");
      } else {
        setError(payload.message || "El correo quedó preparado pero no se envió (falta configurar Resend).");
        setWorkStatus("error");
      }
    } catch (emailError) {
      setError(emailError instanceof Error ? emailError.message : "No se pudo enviar el correo.");
      setWorkStatus("error");
    } finally {
      setEmailSending(false);
    }
  }

  async function sendChatMessage() {
    const message = chatInput.trim();
    if ((!message && !chatFiles.length) || !selectedReport || chatSending) return;
    setChatSending(true);
    setChatInput("");

    const images: Array<{ name: string; dataUrl: string }> = [];
    const texts: Array<{ name: string; content: string }> = [];
    for (const file of chatFiles.slice(0, 4)) {
      if (file.type.startsWith("image/")) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        images.push({ name: file.name, dataUrl });
      } else {
        texts.push({ name: file.name, content: (await file.text()).slice(0, 12000) });
      }
    }
    setChatFiles([]);

    const attachmentNote = [...images, ...texts].map((item) => `📎 ${item.name}`).join("  ");
    const shownMessage = [message, attachmentNote].filter(Boolean).join("\n");
    setChatMessages((current) => [...current, { role: "user", content: shownMessage }]);

    try {
      const payload = await readJson<{ reply: string; chat: Array<{ role: "user" | "assistant"; content: string }> }>(
        await fetch(`/api/module1/reports/${selectedReport.id}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: message || "Analiza los archivos adjuntos.", images, texts }),
        }),
      );
      setChatMessages(payload.chat || []);
    } catch (chatError) {
      setChatMessages((current) => [
        ...current,
        { role: "assistant", content: chatError instanceof Error ? `⚠ ${chatError.message}` : "⚠ No se pudo contactar al agente." },
      ]);
    } finally {
      setChatSending(false);
    }
  }

  async function generateSummary() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("Actualizando los datos de la semana antes de generar el reporte...");

    try {
      const updated = await readJson<Report>(
        await fetch(`/api/module1/reports/${selectedReport.id}/summary`, { method: "POST" }),
      );
      setSelectedReport(updated);
      setReports((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setCommentsDraft(updated.comments || "");
      setEmailDraft(updated.emailDraft || "");
      setError("Reporte generado y guardado. Puedes abrirlo desde la bandeja del Historial.");
      setWorkStatus("ready");
    } catch (summaryError) {
      setError(summaryError instanceof Error ? summaryError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function createClickupTask() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("Creando tarea en ClickUp para este reporte...");

    try {
      const payload = await readJson<{ task: NonNullable<Report["clickupTask"]>; report: Report }>(
        await fetch(`/api/clickup/reports/${selectedReport.id}/task`, { method: "POST" }),
      );
      setSelectedReport(payload.report);
      setReports((current) => current.map((item) => (item.id === payload.report.id ? payload.report : item)));
      setError(payload.task.url ? `Tarea creada en ClickUp: ${payload.task.url}` : "Tarea creada en ClickUp.");
      await loadClickupStatus();
      await loadClickupTasks();
      setWorkStatus("ready");
    } catch (clickupError) {
      setError(clickupError instanceof Error ? clickupError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  async function sendEmail() {
    if (!selectedReport) return;
    setWorkStatus("loading");
    setError("");

    try {
      const payload = await readJson<{ report?: Report; message?: string }>(
        await fetch(`/api/module1/reports/${selectedReport.id}/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ recipients: selectedReport.client?.recipients || [] }),
        }),
      );
      if (payload.report) {
        setSelectedReport(payload.report);
        setReports((current) => current.map((item) => (item.id === payload.report?.id ? payload.report : item)));
      }
      setError(payload.message || "");
      setWorkStatus("ready");
    } catch (emailError) {
      setError(emailError instanceof Error ? emailError.message : "Error desconocido.");
      setWorkStatus("error");
    }
  }

  useEffect(() => {
    checkSession();
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthStatus("anonymous");
      setError("Tu sesión expiró. Vuelve a ingresar para continuar.");
    };
    window.addEventListener("bevinco:unauthorized", onUnauthorized);
    return () => window.removeEventListener("bevinco:unauthorized", onUnauthorized);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    localStorage.setItem("bevinco-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!error || workStatus === "loading") return;
    const timer = setTimeout(() => setError(""), workStatus === "error" ? 9000 : 5500);
    return () => clearTimeout(timer);
  }, [error, workStatus]);

  useEffect(() => {
    setChatMessages(selectedReport?.chat || []);
    setEmailRecipients(selectedReport?.emailLog?.recipients || selectedReport?.client?.recipients || []);
    setEmailSubject(
      selectedReport?.emailLog?.subject ||
        `Reporte ${selectedReport?.monthly ? "mensual" : "semanal"} Bevinco - ${selectedReport?.client?.name || ""}`.trim(),
    );
    setEmailRecipientInput("");
  }, [selectedReport?.id]);

  // Ademas del mes elegido se muestran las semanas de los meses vecinos: el
  // "mes contable" del cliente puede cruzar el mes calendario.
  const monthlyPeriods = useMemo(() => {
    if (!monthlyMonth) return [];
    const [year, month] = monthlyMonth.split("-").map(Number);
    const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
    const visibleMonths = new Set([
      month === 1 ? monthKey(year - 1, 12) : monthKey(year, month - 1),
      monthlyMonth,
      month === 12 ? monthKey(year + 1, 1) : monthKey(year, month + 1),
    ]);
    return clientPeriods
      .filter((period) => visibleMonths.has(monthFromPeriod(period)))
      .sort((left, right) => String(left.startsAt || "").localeCompare(String(right.startsAt || "")));
  }, [clientPeriods, monthlyMonth]);

  useEffect(() => {
    if (!monthlyMonth && clientPeriods.length) {
      const latest = monthFromPeriod(clientPeriods[0]);
      if (latest) setMonthlyMonth(latest);
    }
  }, [clientPeriods, monthlyMonth]);

  const monthlyInitRef = useRef("");
  useEffect(() => {
    const key = `${selectedSculptureUnitId}|${selectedClientId}|${monthlyMonth}`;
    if (!monthlyPeriods.length) {
      // La lista aun no llega para esta combinacion: limpiar sin marcarla
      // como inicializada, para preseleccionar cuando cargue.
      if (monthlyInitRef.current !== key) setMonthlySelectedIds([]);
      return;
    }
    if (monthlyInitRef.current === key) return; // ya inicializado: NUNCA pisar lo que marco el usuario
    monthlyInitRef.current = key;
    const today = new Date().toISOString().slice(0, 10);
    const ofMonth = monthlyPeriods.filter((period) => monthFromPeriod(period) === monthlyMonth);
    const closed = ofMonth.filter((period) => period.endsAt && period.endsAt < today).map((period) => period.id);
    setMonthlySelectedIds(closed.length ? closed : ofMonth.map((period) => period.id));
    setMonthlyReport(null);
  }, [monthlyMonth, monthlyPeriods, selectedSculptureUnitId, selectedClientId]);

  useEffect(() => {
    if (authStatus !== "authenticated") return;
    fetch("/api/presence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ presence }),
    }).catch(() => {});
  }, [authStatus, presence]);

  useEffect(() => {
    if (authStatus === "authenticated") {
      loadModule();
      loadClickupStatus();
      if (userCanAccess(currentUserInfo, "users")) loadUsers();
    }
  }, [authStatus, currentUserInfo]);

  useEffect(() => {
    if (authStatus === "authenticated" && ["dashboard", "tasks"].includes(activeView)) {
      loadClickupStatus();
      loadClickupMeta();
      loadClickupTasks(0, clickupStatusFilter);
      loadCalendarTasks();
    }
  }, [authStatus, activeView]);

  useEffect(() => {
    if (authStatus === "authenticated" && !sculptureDirectoryLoaded) {
      loadSculptureUnits({ quiet: true });
    }
  }, [authStatus, sculptureDirectoryLoaded]);

  useEffect(() => {
    if (authStatus === "authenticated" && activeView === "users") {
      loadUsers();
    }
  }, [authStatus, activeView]);

  useEffect(() => {
    const unit =
      sculptureUnits.find((item) => item.id === selectedSculptureUnitId) ||
      (sculptureDirectoryLoaded ? clients.find((client) => client.id === selectedClientId) : null) ||
      null;
    if (!unit && !sculptureDirectoryLoaded) return;
    loadClientPeriods(unit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSculptureUnitId, selectedClientId, sculptureUnits.length, sculptureDirectoryLoaded]);

  const visibleReports = useMemo(() => reports.filter((report) => !report.backfill), [reports]);
  const reportRows = useMemo(() => {
    const query = reportSearch.trim().toLowerCase();
    return visibleReports.filter((report) => {
      if (reportStatusFilter !== "Todos" && report.status !== reportStatusFilter) return false;
      if (!query) return true;
      const haystack = `${report.client?.name || report.clientId} ${report.period?.label || report.periodId}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [visibleReports, reportSearch, reportStatusFilter]);
  const REPORTS_PER_PAGE = 6;
  const reportPageCount = Math.max(1, Math.ceil(reportRows.length / REPORTS_PER_PAGE));
  const currentReportPage = Math.min(reportPage, reportPageCount - 1);
  const pagedReportRows = reportRows.slice(
    currentReportPage * REPORTS_PER_PAGE,
    currentReportPage * REPORTS_PER_PAGE + REPORTS_PER_PAGE,
  );

  useEffect(() => {
    setReportPage(0);
  }, [reportSearch, reportStatusFilter]);
  const clickupTasksByStatus = useMemo(() => {
    const groups = new Map<string, ClickupTask[]>();
    clickupTasks.forEach((task) => {
      const status = task.status || "Sin estado";
      groups.set(status, [...(groups.get(status) || []), task]);
    });
    return Array.from(groups.entries());
  }, [clickupTasks]);
  const clickupStatusOptions = useMemo(() => {
    const statusSet = new Set<string>();
    clickupMeta.importantStatuses.forEach((status) => statusSet.add(status));
    (clickupMeta.list?.statuses || []).forEach((status) => statusSet.add(status.status));
    clickupTasks.forEach((task) => statusSet.add(task.status));
    return Array.from(statusSet).filter(Boolean);
  }, [clickupMeta, clickupTasks]);
  const dashboardSummary = useMemo(() => {
    const sourceKeys = Object.keys(sourceLabels);
    const reportsWithSources = reports.map((report) => {
      const loadedSources = sourceKeys.filter((key) => ["Sincronizado", "Datos cargados"].includes(report.sourceStatus?.[key] || ""));
      const missingSources = sourceKeys.filter((key) => !loadedSources.includes(key));
      return { report, loadedSources, missingSources };
    });
    const blockedReports = reportsWithSources.filter((item) => item.missingSources.length > 0);
    const draftReports = reports.filter((report) => report.status === "Borrador");
    const readyReports = reports.filter((report) => report.status === "Listo para revisar");
    const sentReports = reports.filter((report) => report.status === "Enviado");
    const highVarianceReports = [...reports]
      .filter((report) => Math.abs(report.summary?.varianceAmount || 0) > 0 || Math.abs(report.summary?.variancePercent || 0) > 0)
      .sort((left, right) => Math.abs(right.summary?.varianceAmount || 0) - Math.abs(left.summary?.varianceAmount || 0))
      .slice(0, 4);
    const dueTasks = [...clickupTasks]
      .filter((task) => task.dueDate)
      .sort((left, right) => Number(left.dueDate || 0) - Number(right.dueDate || 0))
      .slice(0, 5);
    const attentionItems = [
      ...blockedReports.slice(0, 3).map((item) => ({
        id: `sources-${item.report.id}`,
        title: item.report.client?.name || item.report.clientId,
        meta: item.report.period?.label || item.report.periodId,
        detail: "Faltan datos de la auditoría para completar este reporte.",
        action: "Abrir reporte",
        onClick: () => {
          setSelectedClientId(item.report.clientId);
          setSelectedPeriodId(item.report.periodId);
          setSelectedReport(item.report);
          setCommentsDraft(item.report.comments || "");
          setEmailDraft(item.report.emailDraft || "");
          setActiveView("module1");
        },
      })),
      ...readyReports.slice(0, 2).map((report) => ({
        id: `ready-${report.id}`,
        title: report.client?.name || report.clientId,
        meta: report.period?.label || report.periodId,
        detail: "Reporte listo para revisión final, PDF y envío al cliente.",
        action: "Revisar",
        onClick: () => {
          setSelectedClientId(report.clientId);
          setSelectedPeriodId(report.periodId);
          setSelectedReport(report);
          setCommentsDraft(report.comments || "");
          setEmailDraft(report.emailDraft || "");
          setActiveView("module1");
        },
      })),
    ].slice(0, 5);

    // Resumen operativo de la ultima semana de cada restaurante: ventas y %
    // de costo ponderado, para que el inicio muestre negocio y no estados
    // tecnicos de sincronizacion (reunion 17-jul).
    const latestByClient = new Map<string, Report>();
    for (const report of reports) {
      if (report.monthly || !report.summary?.revenue) continue;
      const sortKey = (item: Report) => String(item.period?.endsAt || item.updatedAt || "");
      const previous = latestByClient.get(report.clientId);
      if (!previous || sortKey(report) > sortKey(previous)) latestByClient.set(report.clientId, report);
    }
    const latestReports = [...latestByClient.values()];
    const latestRevenue = latestReports.reduce((sum, report) => sum + (report.summary?.revenue || 0), 0);
    const latestUsedCost = latestReports.reduce(
      (sum, report) => sum + ((report.summary?.costPercent || 0) / 100) * (report.summary?.revenue || 0),
      0,
    );

    return {
      reportsWithSources,
      blockedReports,
      draftReports,
      readyReports,
      sentReports,
      highVarianceReports,
      dueTasks,
      attentionItems,
      latestRevenue,
      latestCostPercent: latestRevenue ? (latestUsedCost / latestRevenue) * 100 : 0,
      latestCount: latestReports.length,
    };
  }, [reports, clickupTasks]);
  const maxRevenue = Math.max(...(selectedReport?.history.map((item) => item.revenue) || [1]), 1);
  const maxAbsVariance = Math.max(...(selectedReport?.history.map((item) => Math.abs(item.varianceAmount)) || [1]), 1);
  // Ahorro/faltante agrupado en las familias del reporte (Destilados, Vinos...),
  // igual que el grafico del PDF; si el reporte no las trae, caen las categorias.
  const familyVarianceRows = (selectedReport?.familyVariances || []).filter((item) => item.amount);
  const maxFamilyVariance = Math.max(
    ...(familyVarianceRows.length
      ? familyVarianceRows.map((item) => Math.abs(item.amount))
      : selectedReport?.categoryVariances.map((item) => Math.abs(item.amount)) || [1]),
    1,
  );
  const maxProductVariance = Math.max(...(selectedReport?.topProducts.map((item) => Math.abs(item.varianceAmount)) || [1]), 1);
  const selectedClient = clients.find((client) => client.id === selectedClientId) || selectedReport?.client || null;
  const selectedUnitInfo = sculptureUnits.find((item) => item.id === selectedSculptureUnitId) || null;
  const viewMeta = {
    dashboard: ["CMS operativo", "Reportes Bevinco/Sculpture"],
    module1: ["Operación semanal", "Reportes semanales"],
    monthly: ["Operación mensual", "Reportes mensuales"],
    tasks: ["Gestión operativa", "Pendientes ClickUp"],
    reports: ["Historial", "Reportes generados"],
    criteria: ["Base de conocimiento", "Criterios para el agente de reportes"],
    users: ["Administración", "Usuarios y permisos"],
  }[activeView];

  if (authStatus === "checking") {
    return (
      <main className="loading-shell">
        <div className="brand">
          <SculptureMark />
          <div>
            <strong>Sculpture Hospitality</strong>
            <span>Validando sesión</span>
          </div>
        </div>
      </main>
    );
  }

  if (authStatus === "anonymous") return <LoginScreen onLogin={checkSession} />;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <SculptureMark />
          <div>
            <strong>Sculpture Hospitality</strong>
            <span>Bevinco CMS</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="Modulos">
          {userCanAccess(currentUserInfo, "dashboard") ? <button className={activeView === "dashboard" ? "active" : ""} onClick={() => navigateTo("dashboard")}><LayoutDashboard size={18} /> Inicio</button> : null}
          {userCanAccess(currentUserInfo, "module1") ? <button className={activeView === "module1" ? "active" : ""} onClick={() => navigateTo("module1")}><ClipboardList size={18} /> Reportes semanales</button> : null}
          {userCanAccess(currentUserInfo, "module1") ? <button className={activeView === "monthly" ? "active" : ""} onClick={() => navigateTo("monthly")}><CalendarDays size={18} /> Reportes mensuales</button> : null}
          {userCanAccess(currentUserInfo, "tasks") ? <button className={activeView === "tasks" ? "active" : ""} onClick={() => navigateTo("tasks")}><ListChecks size={18} /> Pendientes</button> : null}
          {userCanAccess(currentUserInfo, "reports") ? <button className={activeView === "reports" ? "active" : ""} onClick={() => navigateTo("reports")}><FileText size={18} /> Historial</button> : null}
          {userCanAccess(currentUserInfo, "criteria") ? <button className={activeView === "criteria" ? "active" : ""} onClick={() => navigateTo("criteria")}><Upload size={18} /> Criterios</button> : null}
          {userCanAccess(currentUserInfo, "users") ? <button className={activeView === "users" ? "active" : ""} onClick={() => navigateTo("users")}><Users size={18} /> Usuarios</button> : null}
        </nav>
        <div className="sidebar-user">
          {userMenuOpen ? (
            <div className="user-menu" role="menu">
              <p className="user-menu-title">Estado de sesión</p>
              {presenceOptions.map((option) => (
                <button
                  key={option.id}
                  className="user-menu-item"
                  onClick={() => {
                    setPresence(option.id);
                    localStorage.setItem("bevinco-presence", option.id);
                    setUserMenuOpen(false);
                  }}
                >
                  <span className={`presence-dot presence-${option.id}`} />
                  {option.label}
                  {presence === option.id ? <span className="user-menu-check">✓</span> : null}
                </button>
              ))}
              <div className="user-menu-divider" />
              <button
                className="user-menu-item"
                onClick={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
              >
                {themeMode === "dark" ? <Sun size={15} /> : <Moon size={15} />}
                {themeMode === "dark" ? "Modo claro" : "Modo oscuro"}
              </button>
              <button className="user-menu-item" onClick={logout}>
                <LogOut size={15} /> Cerrar sesión
              </button>
            </div>
          ) : null}
          <button className="sidebar-user-button" onClick={() => setUserMenuOpen((open) => !open)}>
            <span className="sidebar-user-avatar">
              {(currentUserInfo?.name || currentUser || "U").slice(0, 1).toUpperCase()}
              <span className={`presence-dot presence-badge presence-${presence}`} />
            </span>
            <span className="sidebar-user-info">
              <strong>{currentUserInfo?.name || currentUser}</strong>
              <small>{presenceOptions.find((option) => option.id === presence)?.label || "Disponible"}</small>
            </span>
          </button>
        </div>
      </aside>

      <section className={`workspace workspace-${activeView}`}>
        <header className="topbar" id="dashboard">
          <div>
            <p className="eyebrow">{viewMeta[0]}</p>
            <h1>{viewMeta[1]}</h1>
          </div>
        </header>

        {isAdminUser(currentUserInfo) && backupStatus && (!backupStatus.configured || backupStatus.lastError) ? (
          <div className="backup-banner" role="alert">
            <strong>Respaldo de datos:</strong>{" "}
            {backupStatus.configured
              ? backupStatus.lastError
              : "Supabase sin configurar: los reportes y criterios no sobreviven reinicios del servidor."}
          </div>
        ) : null}

        {error ? (
          <div
            className={`toast ${
              workStatus === "error" || /error|fall[oó]|no se pudo|no pudimos|invalid|requerid/i.test(error)
                ? "toast-error"
                : workStatus === "loading"
                  ? "toast-info"
                  : "toast-success"
            }`}
            role="status"
          >
            <span>
              {/CLICKUP|token|OAuth|configured/i.test(error) && !isAdminUser(currentUserInfo)
                ? "ClickUp no está disponible en este momento. Avisa al administrador."
                : error}
            </span>
            <button aria-label="Cerrar aviso" onClick={() => setError("")}>×</button>
          </div>
        ) : null}

        {activeView === "dashboard" ? (
          <section className="dashboard-view">
            <section className="dashboard-hero">
              <div>
                <p className="eyebrow">Accesos rápidos</p>
                <h2>¿Qué necesitas hacer hoy?</h2>
              </div>
              <div className="dashboard-hero-actions">
                <button className="primary-button" onClick={() => setActiveView("module1")}><ClipboardList size={17} /> Reportes semanales</button>
                <button className="secondary-button" onClick={() => setActiveView("monthly")}><CalendarDays size={17} /> Reportes mensuales</button>
                <button className="secondary-button" onClick={() => setActiveView("tasks")}><ListChecks size={17} /> Pendientes</button>
                <button className="secondary-button" onClick={() => { setReportStatusFilter("Todos"); navigateTo("reports"); }}><FileText size={17} /> Historial</button>
              </div>
            </section>

            <section className="panel workflow-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Flujo de trabajo · ClickUp</p>
                  <h2>Estado de las auditorías</h2>
                </div>
                <ListChecks size={22} />
              </div>
              <div className="workflow-board">
                {WORKFLOW_COLUMNS.map((column) => {
                  const windowStart = Date.now() - WORKFLOW_WINDOW_DAYS * 86400000;
                  const boardTasks = (calendarTasks.length ? calendarTasks : clickupTasks)
                    .filter((task) => !WORKFLOW_HIDDEN_STATUS.test(task.status || ""))
                    .filter((task) => !task.dueDate || task.dueDate >= windowStart);
                  // Cada tarea cae en UNA sola columna: la primera cuyo regex
                  // matchea, y si ninguna matchea, en la columna sin regex.
                  // Antes se filtraba columna por columna sin destino final, asi
                  // que un estado no contemplado no aparecia en ninguna parte.
                  const cards = boardTasks.filter((task) => {
                    const owner = WORKFLOW_COLUMNS.find((item) => item.match && item.match.test(task.status || ""));
                    return owner ? owner.title === column.title : !column.match;
                  });
                  const totalPages = Math.max(1, Math.ceil(cards.length / WORKFLOW_CARDS_PER_PAGE));
                  const page = Math.min(workflowPages[column.title] || 0, totalPages - 1);
                  const pageCards = cards.slice(page * WORKFLOW_CARDS_PER_PAGE, (page + 1) * WORKFLOW_CARDS_PER_PAGE);
                  return (
                    <div className="workflow-col" key={column.title}>
                      <header>
                        <strong>{column.title}</strong>
                        <span>{cards.length}</span>
                      </header>
                      {cards.length ? pageCards.map((task) => (
                        <article className="workflow-card" key={task.id}>
                          <a className="workflow-card-open" href={task.url} target="_blank" rel="noreferrer">
                            <strong>{task.name}</strong>
                            <small>{task.dueDate ? shortDate(task.dueDate) : task.status}</small>
                          </a>
                          <select
                            aria-label={`Mover ${task.name} de estado`}
                            value={column.match ? column.title : ""}
                            onChange={(event) => moveClickupTask(task, event.target.value)}
                          >
                            {/* "Otros" es el catch-all: no es un estado de ClickUp
                                y por lo tanto no es un destino valido. Se muestra
                                el estado crudo para que el equipo vea que aparecio. */}
                            {column.match ? null : <option value="" disabled>{task.status || "Sin estado"}</option>}
                            {WORKFLOW_COLUMNS.filter((option) => option.match).map((option) => <option key={option.title} value={option.title}>{option.title}</option>)}
                          </select>
                        </article>
                      )) : <p className="workflow-empty">Sin tareas aquí.</p>}
                      {totalPages > 1 ? (
                        <footer className="workflow-pager">
                          <button
                            aria-label="Página anterior"
                            disabled={page === 0}
                            type="button"
                            onClick={() => setWorkflowPages((current) => ({ ...current, [column.title]: page - 1 }))}
                          >‹</button>
                          <span>{page + 1} / {totalPages}</span>
                          <button
                            aria-label="Página siguiente"
                            disabled={page >= totalPages - 1}
                            type="button"
                            onClick={() => setWorkflowPages((current) => ({ ...current, [column.title]: page + 1 }))}
                          >›</button>
                        </footer>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="panel week-calendar-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Auditorías</p>
                  <h2>
                    {calendarWeekOffset === 0
                      ? "Calendario de la semana"
                      : calendarWeekOffset === 1
                        ? "Próxima semana"
                        : calendarWeekOffset === -1
                          ? "Semana pasada"
                          : `Semana ${calendarWeekOffset > 0 ? "+" : ""}${calendarWeekOffset}`}
                  </h2>
                </div>
                <div className="action-row wrap-actions week-nav">
                  <button className="secondary-button" type="button" onClick={() => setCalendarWeekOffset((current) => current - 1)}>‹ Anterior</button>
                  {calendarWeekOffset !== 0 ? (
                    <button className="secondary-button" type="button" onClick={() => setCalendarWeekOffset(0)}>Hoy</button>
                  ) : null}
                  <button className="secondary-button" type="button" onClick={() => setCalendarWeekOffset((current) => current + 1)}>Siguiente ›</button>
                  <a className="button-link" href={CLICKUP_CALENDAR_URL} target="_blank" rel="noreferrer">
                    <CalendarDays size={17} /> Abrir en ClickUp
                  </a>
                </div>
              </div>
              <div className="week-calendar">
                {(() => {
                  const today = new Date();
                  const monday = new Date(today);
                  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7) + calendarWeekOffset * 7);
                  return ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes"].map((label, index) => {
                    const day = new Date(monday);
                    day.setDate(monday.getDate() + index);
                    const dayKey = day.toDateString();
                    const sourceTasks = calendarTasks.length ? calendarTasks : clickupTasks;
                    const dayTasks = sourceTasks.filter((task) => task.dueDate && new Date(Number(task.dueDate)).toDateString() === dayKey);
                    const isToday = dayKey === today.toDateString();
                    return (
                      <div className={`week-day ${isToday ? "is-today" : ""}`} key={label}>
                        <header>
                          <strong>{label}</strong>
                          <span>{day.getDate()}/{day.getMonth() + 1}</span>
                        </header>
                        {dayTasks.length ? dayTasks.map((task) => {
                          const accent = task.tagDetails?.[0]?.bg || task.statusColor || "#8bc6c1";
                          return (
                            <a className="week-task" href={task.url} key={task.id} target="_blank" rel="noreferrer" style={{ borderLeftColor: accent }}>
                              <strong>{task.name}</strong>
                              <span className="week-task-tags">
                                {(task.tagDetails || []).slice(0, 3).map((tag) => (
                                  <i className="week-tag" key={tag.name} style={{ backgroundColor: tag.bg ? `${tag.bg}22` : undefined, color: tag.bg || undefined }}>
                                    {tag.name}
                                  </i>
                                ))}
                              </span>
                              <span className="week-task-foot">
                                <i className="week-status-dot" style={{ backgroundColor: task.statusColor || "#9db0aa" }} />
                                <small>{task.status}</small>
                                <span className="week-avatars">
                                  {(task.assignees || []).slice(0, 3).map((person) => (
                                    <b key={person.id || person.initials} style={{ backgroundColor: person.color || "#054372" }} title={person.username || ""}>
                                      {(person.initials || person.username || "?").slice(0, 2).toUpperCase()}
                                    </b>
                                  ))}
                                </span>
                              </span>
                            </a>
                          );
                        }) : <p className="workflow-empty">—</p>}
                      </div>
                    );
                  });
                })()}
              </div>
            </section>
          </section>
        ) : null}

        {activeView === "module1" ? (
          <>
        <section className="panel unit-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Sculpture Hospitality</p>
              <h2>Consultar reportes por restaurante</h2>
            </div>
            <Building2 size={22} />
          </div>
          <div className="unit-grid">
            <div className="unit-summary">
              <article>
                <span>Cliente</span>
                <strong>{selectedUnitInfo?.accountName || clientAccountLabel(selectedClient)}</strong>
              </article>
              <article>
                <span>Área</span>
                <strong>{selectedUnitInfo?.area || selectedClient?.area || "Food"}</strong>
              </article>
              <article>
                <span>Estado</span>
                {selectedReport ? (
                  <select
                    className="unit-state-select"
                    aria-label="Estado del flujo de trabajo"
                    value={workflowStateFor(selectedReport)}
                    onChange={(event) => setReportWorkflowState(selectedReport, event.target.value)}
                  >
                    {WORKFLOW_STATES.map((option) => <option key={option} value={option}>{option}</option>)}
                  </select>
                ) : (
                  <strong>Sin reporte</strong>
                )}
              </article>
            </div>

            <div className="unit-form">
              <div>
                <p className="eyebrow">Consulta directa</p>
                <strong>Selecciona restaurante y rango</strong>
              </div>
              <div className="unit-form-grid">
                <label>
                  Restaurante/local
                  <select
                    value={selectedSculptureUnitId || (selectedClientId ? `cms:${selectedClientId}` : "")}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value.startsWith("cms:")) {
                        setSelectedClientId(value.slice(4));
                        setSelectedSculptureUnitId("");
                      } else {
                        setSelectedSculptureUnitId(value);
                      }
                    }}
                    onFocus={ensureSculptureDirectory}
                    onMouseDown={ensureSculptureDirectory}
                  >
                    {sculptureUnits.filter((unit) => !unit.hidden).length ? (
                      sculptureUnits.filter((unit) => !unit.hidden).map((unit) => (
                        <option key={unit.id} value={unit.id}>
                          {unit.name} - {unit.area}
                        </option>
                      ))
                    ) : clients.length ? (
                      clients.map((client) => (
                        <option key={client.id} value={`cms:${client.id}`}>
                          {clientDisplayName(client)} - {client.area || "Food"}
                        </option>
                      ))
                    ) : workStatus === "loading" && !sculptureDirectoryLoaded ? (
                      <option value="">Cargando restaurantes...</option>
                    ) : (
                      <option value="">No hay restaurantes disponibles</option>
                    )}
                  </select>
                </label>
                <label>
                  Periodo
                  <select value={selectedPeriodId} onChange={(event) => setSelectedPeriodId(event.target.value)}>
                    <option value="">
                      {clientPeriodsLoading
                        ? "Cargando periodos del restaurante..."
                        : clientPeriods.length
                          ? `Última semana cerrada (${clientPeriods.length} disponibles)`
                          : "Selecciona un restaurante para ver sus periodos"}
                    </option>
                    {clientPeriods.map((period) => (
                      <option key={period.id} value={period.id}>
                        {period.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="query-actions">
                <button className="primary-button" disabled={workStatus === "loading" || (!selectedSculptureUnitId && !selectedClientId)} onClick={querySculptureReports} type="button">
                  {workStatus === "loading" ? <span className="btn-spinner" /> : <Database size={17} />}
                  {workStatus === "loading" ? "Generando..." : "Generar reporte"}
                </button>
                {selectedReport ? (
                  <a className="button-link" href={`/api/module1/reports/${selectedReport.id}/export`} target="_blank" rel="noreferrer">
                    <Printer size={17} /> Exportar PDF
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </section>


        <section className="metrics metrics-five" aria-label="Resumen">
          <article>
            <span><FileSpreadsheet size={18} /> Ingresos</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : money(selectedReport?.summary.revenue || 0)}</strong>
            <small>{selectedReport?.period?.label || "Sin periodo"}</small>
          </article>
          <article>
            <span><BarChart3 size={18} /> Costo</span>
            <strong>
              {workStatus === "loading"
                ? <span className="skeleton" />
                : money(selectedReport?.summary.usedCost || ((selectedReport?.summary.costPercent || 0) / 100) * (selectedReport?.summary.revenue || 0))}
            </strong>
            <small>Usado al costo</small>
          </article>
          <article>
            <span><FileText size={18} /> Diferencia costo</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : money(selectedReport?.summary.varianceAmount || 0)}</strong>
            <small>{workStatus === "loading" ? "Actualizando..." : `${selectedReport?.summary.variancePercent || 0}% del vendido`}</small>
          </article>
          <article>
            <span><TrendingUp size={18} /> % Costo Real</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : `${selectedReport?.summary.costPercent || 0}%`}</strong>
            <small>Food cost / pour cost</small>
          </article>
          <article>
            <span><TrendingDown size={18} /> % Costo Ideal</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : `${selectedReport?.summary.idealCostPercent || 0}%`}</strong>
            <small>Según recetas y ventas</small>
          </article>
        </section>

        <section className="panel workspace-panel" id="workspace">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Reporte generado{selectedReport?.period?.label ? ` · ${selectedReport.period.label}` : ""}</p>
              <h2>Trabajar el reporte</h2>
            </div>
            <button className="primary-button" disabled={!selectedReport || workStatus === "loading"} onClick={generateSummary}>
              {workStatus === "loading" ? <span className="btn-spinner" /> : <Bot size={17} />}
              {workStatus === "loading" ? "Redactando..." : "Redactar con IA"}
            </button>
          </div>
          <div className="report-tabs" role="tablist">
            <button className={reportTab === "chat" ? "active" : ""} role="tab" onClick={() => setReportTab("chat")}>
              <Bot size={15} /> Chat con el agente
            </button>
            <button className={reportTab === "send" ? "active" : ""} role="tab" onClick={() => setReportTab("send")}>
              <Send size={15} /> Enviar{selectedReport?.emailLog ? " ✓" : ""}
            </button>
          </div>

          {reportTab === "chat" ? (
            <div className="report-tab-body">
            <div className="chat-thread" aria-live="polite">
              {!chatMessages.length ? (
                <div className="chat-empty">
                  <p>El agente ya conoce los datos de la semana y los criterios de {selectedClient?.name || "este cliente"}. Pídele lo que necesites:</p>
                  <div className="chat-suggestions">
                    {["Menciona que en Schop puede faltar una factura", "Haz el resumen más breve y directo", "Redacta el correo en tono más formal"].map((suggestion) => (
                      <button key={suggestion} type="button" onClick={() => setChatInput(suggestion)}>{suggestion}</button>
                    ))}
                  </div>
                </div>
              ) : (
                chatMessages.map((item, index) => (
                  <div className={`chat-bubble ${item.role}`} key={`${index}-${item.content.slice(0, 12)}`}>
                    <div className="chat-bubble-content">{item.content}</div>
                    {item.role === "assistant" && !item.content.startsWith("⚠") ? (
                      <div className="chat-bubble-actions">
                        <button type="button" onClick={() => applyChatAsSummary(item.content)}>Usar como resumen</button>
                        <button type="button" onClick={() => setEmailDraft(item.content)}>Usar como correo</button>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
              {chatSending ? (
                <div className="chat-bubble assistant">
                  <div className="chat-bubble-content chat-typing"><span /><span /><span /></div>
                </div>
              ) : null}
            </div>
            {chatMessages.length >= 2 ? (
              <div className="chat-learn-bar">
                <button className="secondary-button" disabled={chatLearning} type="button" onClick={learnFromChat}>
                  {chatLearning ? <span className="btn-spinner btn-spinner-dark" /> : <BookOpenCheck size={16} />}
                  {chatLearning ? "Guardando memoria..." : "Guardar aprendizajes en el criterio del cliente"}
                </button>
                <small>La IA extrae solo las reglas perdurables del chat (ignora pedidos puntuales) y las suma a la skill de {selectedClient?.name || "este cliente"}.</small>
              </div>
            ) : null}
            {chatFiles.length ? (
              <div className="chat-attachments">
                {chatFiles.map((file) => (
                  <span className="email-chip" key={`${file.name}-${file.size}`}>
                    📎 {file.name}
                    <button type="button" aria-label={`Quitar ${file.name}`} onClick={() => setChatFiles((current) => current.filter((item) => item !== file))}>×</button>
                  </span>
                ))}
              </div>
            ) : null}
            <div className="chat-composer">
              <label className="chat-attach" title="Adjuntar imágenes o archivos de texto">
                <Paperclip size={17} />
                <input
                  accept="image/png,image/jpeg,image/webp,.txt,.md,.csv"
                  multiple
                  type="file"
                  onChange={(event) => {
                    const files = Array.from(event.target.files || []).filter((file) => file.size <= 4 * 1024 * 1024);
                    setChatFiles((current) => [...current, ...files].slice(0, 4));
                    event.target.value = "";
                  }}
                />
              </label>
              <textarea
                placeholder={selectedReport ? "Escribe tu ajuste o pregunta..." : "Genera un reporte primero para conversar sobre él."}
                disabled={!selectedReport || chatSending}
                rows={2}
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendChatMessage();
                  }
                }}
              />
              <button className="primary-button" disabled={!selectedReport || chatSending || (!chatInput.trim() && !chatFiles.length)} onClick={sendChatMessage}>
                {chatSending ? <span className="btn-spinner" /> : <Send size={17} />}
                Enviar
              </button>
            </div>
            </div>
          ) : null}

          {reportTab === "send" ? (
            <div className="report-tab-body">
            {selectedReport?.emailLog ? (
              <p className="email-sent-note">
                ✓ Último envío: {new Date(selectedReport.emailLog.sentAt).toLocaleString("es-CL")} a {selectedReport.emailLog.recipients.join(", ")}
              </p>
            ) : null}
            <div className="email-grid">
              <label>
                Destinatarios
                <div className="email-recipients">
                  {emailRecipients.map((email) => (
                    <span className="email-chip" key={email}>
                      {email}
                      <button aria-label={`Quitar ${email}`} type="button" onClick={() => setEmailRecipients((current) => current.filter((item) => item !== email))}>×</button>
                    </span>
                  ))}
                  <input
                    placeholder={emailRecipients.length ? "Agregar otro..." : "correo@cliente.com"}
                    value={emailRecipientInput}
                    onChange={(event) => setEmailRecipientInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === "," || event.key === ";") {
                        event.preventDefault();
                        addEmailRecipient();
                      }
                    }}
                    onBlur={() => emailRecipientInput.trim() && addEmailRecipient()}
                  />
                </div>
                <small className="email-hint">Quedan guardados para los próximos envíos de este cliente.</small>
              </label>
              <label>
                Asunto
                <input value={emailSubject} onChange={(event) => setEmailSubject(event.target.value)} />
              </label>
            </div>
            <label className="email-body-field">
              Cuerpo del correo
              <textarea
                aria-label="Cuerpo del email"
                placeholder="Resumen ejecutivo breve para el cliente. Usa 'Redactar con IA' o pídeselo al chat y aplica 'Usar como correo'."
                value={emailDraft}
                onChange={(event) => setEmailDraft(event.target.value)}
              />
            </label>
            <div className="email-preview">
              <strong>Se enviará:</strong>
              <span>este cuerpo + el PDF del reporte y el variance detallado adjuntos.</span>
            </div>
            <div className="action-row wrap-actions">
              <button className="primary-button" disabled={!selectedReport || emailSending || !emailRecipients.length} onClick={sendReportEmail} type="button">
                {emailSending ? <span className="btn-spinner" /> : <Send size={17} />}
                {emailSending ? "Enviando..." : `Enviar a ${emailRecipients.length || 0} destinatario(s)`}
              </button>
            </div>
            </div>
          ) : null}
        </section>

        {selectedReport?.analysis ? (
          <section className="panel agent-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Análisis del agente</p>
                <h2>Lectura ejecutiva del periodo</h2>
              </div>
              <Bot size={22} />
            </div>
            <div className="agent-analysis-grid">
              {[
                {
                  key: "bestOfWeek",
                  title: "Lo mejor de la semana",
                  tone: "pos",
                  icon: <TrendingUp size={17} />,
                  items: selectedReport.analysis.bestOfWeek || [],
                  empty: "Sin hallazgos positivos relevantes esta semana.",
                },
                {
                  key: "weeklyChallenges",
                  title: "Los desafíos de la semana",
                  tone: "neg",
                  icon: <TrendingDown size={17} />,
                  items: selectedReport.analysis.weeklyChallenges || [],
                  empty: "Sin desafíos relevantes esta semana.",
                },
                {
                  key: "stockEfficiency",
                  title: "Eficiencia de stock y compra",
                  tone: "info",
                  icon: <ShoppingCart size={17} />,
                  items: selectedReport.analysis.stockEfficiency || [],
                  empty: "Sin observaciones de stock y compra para este periodo.",
                },
                {
                  key: "criteriaApplied",
                  title: "Criterios aplicados",
                  tone: "brand",
                  icon: <BookOpenCheck size={17} />,
                  items: selectedReport.analysis.criteriaApplied || [],
                  empty: "",
                },
              ]
                .filter((block) => block.items.length || block.empty)
                .map((block) => (
                  <article className={`analysis-card tone-${block.tone}`} key={block.key}>
                    <header>
                      <span className="analysis-icon">{block.icon}</span>
                      <strong>{block.title}</strong>
                      {block.items.length ? <span className="analysis-count">{block.items.length}</span> : null}
                    </header>
                    <div className="analysis-items">
                      {(block.items.length ? block.items : [block.empty]).map((item) => (
                        <p className={`analysis-item ${block.items.length ? "" : "is-empty"}`} key={item}>
                          {highlightFigures(item)}
                        </p>
                      ))}
                    </div>
                  </article>
                ))}
            </div>
            {!selectedReport.analysis.criteriaApplied?.length ? (
              <p className="analysis-note">Sin criterios adicionales cargados para este reporte. Sube los criterios del cliente en la sección Criterios.</p>
            ) : null}
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Histórico</p>
              <h2>Últimos 4 periodos</h2>
            </div>
            <BarChart3 size={22} />
          </div>
          <div className="history-chart">
              {selectedReport?.history.map((point) => (
                <article key={point.periodId}>
                  <span>{point.label}</span>
                  <div className="bar-track"><div style={{ width: `${Math.max(8, (point.revenue / maxRevenue) * 100)}%` }} /></div>
                  <small>{money(point.revenue)} - {point.costPercent}% costo</small>
                  <div className="bar-track variance"><div style={{ width: `${Math.max(8, (Math.abs(point.varianceAmount) / maxAbsVariance) * 100)}%` }} /></div>
                  <small>{money(point.varianceAmount)} variance</small>
                </article>
              ))}
            </div>
        </section>

        <section className="module-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Variance</p>
                <h2>Variaciones por familia</h2>
              </div>
            </div>
            <div className="variance-chart">
              {(familyVarianceRows.length
                ? familyVarianceRows
                : (selectedReport?.categoryVariances || []).map((item) => ({ family: item.category, amount: item.amount }))
              ).map((item) => (
                <article key={item.family}>
                  <div>
                    <strong>{item.family}</strong>
                    <span className={item.amount < 0 ? "negative" : "positive"}>{money(item.amount)}</span>
                  </div>
                  <div className="chart-track">
                    <div
                      className={item.amount < 0 ? "negative-bar" : "positive-bar"}
                      style={{ width: `${Math.max(8, (Math.abs(item.amount) / maxFamilyVariance) * 100)}%` }}
                    />
                  </div>
                </article>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Productos</p>
                <h2>Top variaciones</h2>
              </div>
            </div>
            <div className="variance-chart">
              {selectedReport?.topProducts.map((item) => (
                <article key={`${item.name}-${item.category}`}>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.category}</small>
                    <span className={item.varianceAmount < 0 ? "negative" : "positive"}>{money(item.varianceAmount)} - {item.variancePercent}%</span>
                  </div>
                  <div className="chart-track">
                    <div
                      className={item.varianceAmount < 0 ? "negative-bar" : "positive-bar"}
                      style={{ width: `${Math.max(8, (Math.abs(item.varianceAmount) / maxProductVariance) * 100)}%` }}
                    />
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Intelipar</p>
              <h2>Sugerencia de compra</h2>
            </div>
            {selectedReport ? (
              <a className="button-link" href={`/api/module1/reports/${selectedReport.id}/purchase-suggestion`} target="_blank" rel="noreferrer">
                <ShoppingCart size={17} /> Descargar para enviar (CSV)
              </a>
            ) : (
              <ShoppingCart size={22} />
            )}
          </div>
          <div className="purchase-grid">
            {selectedReport?.purchaseSuggestions.map((item) => (
              <article key={`${item.item}-${item.provider}`}>
                <strong>{item.item}</strong>
                <span>{item.provider}</span>
                <small>Stock {item.stock} - sugerido {item.suggested}</small>
                <p>{item.note}</p>
              </article>
            ))}
          </div>
        </section>

        <details className="panel unit-panel collapsible-panel">
          <summary>
            <div>
              <p className="eyebrow">Gestión de clientes</p>
              <h2>Restaurantes de la cartera</h2>
            </div>
            <Building2 size={22} />
          </summary>
          <p className="managed-help">
            Oculta los restaurantes antiguos para que no aparezcan al generar reportes. Puedes restaurarlos cuando quieras.
          </p>
          {sculptureUnits.length ? (
            <ul className="managed-clients">
              {sculptureUnits.map((unit) => (
                <li key={`${unit.sculptureCid || unit.cid}-${unit.area}`} className={unit.hidden ? "is-hidden" : ""}>
                  <div className="managed-client-info">
                    <strong>{unit.name}</strong>
                    <span>{unit.area}{unit.hidden ? " · Oculto" : ""}</span>
                  </div>
                  <button
                    className={unit.hidden ? "managed-client-restore" : "managed-client-delete"}
                    type="button"
                    disabled={workStatus === "loading"}
                    onClick={() => toggleUnitVisibility(unit)}
                  >
                    {unit.hidden ? "Restaurar" : "Ocultar"}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="query-note">Aún no se cargó la lista de restaurantes. Se actualiza automáticamente al iniciar sesión.</p>
          )}
          {clients.length ? (
            <>
              <p className="managed-subtitle">Guardados en el CMS (con reportes)</p>
              <ul className="managed-clients">
                {clients.map((client) => (
                  <li key={client.id} className={client.id === selectedClientId ? "is-selected" : ""}>
                    <button className="managed-client-info" type="button" onClick={() => setSelectedClientId(client.id)}>
                      <strong>{clientDisplayName(client)}</strong>
                      <span>{client.area || "Food"}</span>
                    </button>
                    <button
                      className="managed-client-delete"
                      type="button"
                      disabled={workStatus === "loading"}
                      onClick={() => deleteClient(client.id)}
                      aria-label={`Eliminar ${clientDisplayName(client)}`}
                    >
                      Eliminar
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </details>
          </>
        ) : null}

        {activeView === "monthly" ? (
          <>
          <section className="panel unit-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Acumulado del mes</p>
                <h2>Genera el reporte mensual</h2>
              </div>
              <CalendarDays size={22} />
            </div>
            <p className="managed-help">
              Ingresos, ventas y compras se suman entre las semanas del mes; las existencias y la sugerencia de compra toman el último periodo, igual que en Sculpture.
            </p>
            <div className="unit-form-grid">
              <label>
                Restaurante/local
                <select
                  value={selectedSculptureUnitId || (selectedClientId ? `cms:${selectedClientId}` : "")}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value.startsWith("cms:")) {
                      setSelectedClientId(value.slice(4));
                      setSelectedSculptureUnitId("");
                    } else {
                      setSelectedSculptureUnitId(value);
                    }
                  }}
                >
                  {sculptureUnits.filter((unit) => !unit.hidden).map((unit) => (
                    <option key={unit.id} value={unit.id}>{unit.name} - {unit.area}</option>
                  ))}
                </select>
              </label>
              <label>
                Mes
                <MonthPicker value={monthlyMonth} onChange={setMonthlyMonth} />
              </label>
            </div>
            <div className="monthly-weeks">
              <strong>Semanas que componen el mes</strong>
              <small>{clientPeriodsLoading ? "Cargando periodos del restaurante..." : `${monthlySelectedIds.length} de ${monthlyPeriods.length} seleccionadas — toca una semana para incluirla o quitarla. También puedes sumar semanas de los meses vecinos.`}</small>
              <div className="monthly-week-actions">
                <button type="button" onClick={() => setMonthlySelectedIds(monthlyPeriods.filter((period) => monthFromPeriod(period) === monthlyMonth).map((period) => period.id))}>Todas</button>
                <button type="button" onClick={() => setMonthlySelectedIds([])}>Ninguna</button>
              </div>
              <div className="monthly-week-chips">
                {monthlyPeriods.map((period) => {
                  const active = monthlySelectedIds.includes(period.id);
                  return (
                    <button
                      className={`week-chip ${active ? "active" : ""}`}
                      key={period.id}
                      type="button"
                      onClick={() =>
                        setMonthlySelectedIds((current) =>
                          current.includes(period.id) ? current.filter((id) => id !== period.id) : [...current, period.id],
                        )
                      }
                    >
                      {active ? "✓ " : ""}{period.label}
                    </button>
                  );
                })}
                {!monthlyPeriods.length && !clientPeriodsLoading ? (
                  <span className="managed-help">Este restaurante no tiene periodos en el mes elegido.</span>
                ) : null}
              </div>
            </div>
            <div className="query-actions">
              <button
                className="primary-button"
                disabled={monthlyGenerating || !monthlySelectedIds.length}
                onClick={generateMonthlyReport}
                type="button"
              >
                {monthlyGenerating ? <span className="btn-spinner" /> : <CalendarDays size={17} />}
                {monthlyGenerating ? "Acumulando..." : "Generar reporte mensual"}
              </button>
            </div>
          </section>

          {monthlyReport ? (
            <>
            <section className="metrics" aria-label="Resumen mensual">
              <article>
                <span><FileSpreadsheet size={18} /> Ingresos (suma)</span>
                <strong>{money(monthlyReport.summary.revenue || 0)}</strong>
                <small>{(monthlyReport.includedPeriods || []).length} semana(s)</small>
              </article>
              <article>
                <span><BarChart3 size={18} /> % costo</span>
                <strong>{monthlyReport.summary.costPercent || 0}%</strong>
                <small>Sobre ingresos acumulados</small>
              </article>
              <article>
                <span><FileText size={18} /> Variance (suma)</span>
                <strong>{monthlyReport.summary.variancePercent || 0}%</strong>
                <small>{money(monthlyReport.summary.varianceAmount || 0)}</small>
              </article>
              <article>
                <span><ListChecks size={18} /> Stock</span>
                <strong className="metric-status">Último periodo</strong>
                <small>{(monthlyReport.purchaseSuggestions || []).length} artículo(s)</small>
              </article>
            </section>

            <section className="panel monthly-result">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Reporte mensual</p>
                  <h2>{monthlyReport.period?.label || "Acumulado"} · {monthlyReport.client?.name || ""}</h2>
                </div>
                <CalendarDays size={22} />
              </div>
              <div className="accumulated-periods">
                {(monthlyReport.includedPeriods || []).map((period) => (
                  <span className="accumulated-chip" key={period.id}>{period.label}</span>
                ))}
              </div>
              <div className="action-row wrap-actions">
                <a className="button-link" href={`/api/module1/reports/${monthlyReport.id}/export`} target="_blank" rel="noreferrer">
                  <Printer size={17} /> Exportar PDF
                </a>
                <button className="primary-button" onClick={openMonthlyReport} type="button">
                  <Bot size={17} /> Abrir para análisis, chat y envío
                </button>
              </div>
            </section>
            </>
          ) : null}
          </>
        ) : null}

        {activeView === "tasks" ? (
          <section className="tasks-module">

            <section className="panel clickup-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">ClickUp</p>
                  <h2>Pendientes de auditoría y reportes</h2>
                  <small className="clickup-list-note">
                    Lista: {clickupMeta.list?.name || "Auditorias Chile"} · {clickupTasks.length} tarea(s)
                  </small>
                </div>
                <div className="action-row wrap-actions">
                  <button className="secondary-button" disabled={workStatus === "loading"} onClick={() => loadClickupTasks(clickupPage, clickupStatusFilter)}>
                    <RefreshCw size={17} /> Actualizar
                  </button>
                  <button className="primary-button" disabled={!selectedReport || workStatus === "loading"} onClick={createClickupTask}>
                    <Plus size={17} /> Crear tarea del reporte
                  </button>
                </div>
              </div>
              {!clickupStatus?.connected ? (
                <p className="query-note">ClickUp aún no está conectado. Avisa al administrador para activarlo.</p>
              ) : null}
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Nuevo pendiente</p>
                  <h2>Crear tarea en ClickUp</h2>
                </div>
                <Plus size={22} />
              </div>
              <form className="pending-form" onSubmit={createManualClickupTask}>
                <label>
                  Nombre del pendiente
                  <input
                    placeholder="Ej. Revisar reporte Bardot - Barra"
                    value={newPending.name}
                    onChange={(event) => setNewPending((current) => ({ ...current, name: event.target.value }))}
                  />
                </label>
                <label className="wide-field">
                  Descripción
                  <textarea
                    placeholder="Detalle operativo, contexto, links o criterios para resolverlo."
                    value={newPending.description}
                    onChange={(event) => setNewPending((current) => ({ ...current, description: event.target.value }))}
                  />
                </label>
                <label>
                  Estado
                  <select value={newPending.status} onChange={(event) => setNewPending((current) => ({ ...current, status: event.target.value }))}>
                    {clickupStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                </label>
                <label>
                  Responsable
                  <select value={newPending.assignee} onChange={(event) => setNewPending((current) => ({ ...current, assignee: event.target.value }))}>
                    <option value="">Sin responsable</option>
                    {clickupMeta.members.map((member) => (
                      <option key={member.id || member.email} value={member.id}>{member.username || member.email}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Fecha límite
                  <input type="date" value={newPending.dueDate} onChange={(event) => setNewPending((current) => ({ ...current, dueDate: event.target.value }))} />
                </label>
                <label>
                  Hora
                  <input type="time" value={newPending.dueTime} onChange={(event) => setNewPending((current) => ({ ...current, dueTime: event.target.value }))} />
                </label>
                <label>
                  Prioridad
                  <select value={newPending.priority} onChange={(event) => setNewPending((current) => ({ ...current, priority: event.target.value }))}>
                    <option value="1">Urgente</option>
                    <option value="2">Alta</option>
                    <option value="3">Normal</option>
                    <option value="4">Baja</option>
                  </select>
                </label>
                <button className="primary-button" disabled={workStatus === "loading"} type="submit">
                  <Plus size={17} /> Crear pendiente
                </button>
              </form>
            </section>

            <section className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Flujo ClickUp</p>
                  <h2>Tablero de pendientes</h2>
                </div>
                <div className="task-toolbar">
                  <select
                    value={clickupStatusFilter}
                    onChange={(event) => {
                      setClickupStatusFilter(event.target.value);
                      loadClickupTasks(0, event.target.value);
                    }}
                  >
                    <option value="important">Estados operativos</option>
                    <option value="all">Todos los estados</option>
                    {clickupStatusOptions.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                  <span className="board-page-note">5 por columna</span>
                </div>
              </div>
              <p className="muted-copy">Estados recomendados para ver hoy: falta informacion, auditoria en proceso, graficos actualizados, listo para reporte, comentarios escritos, reporte enviado y cancelado. Inactiva queda fuera del filtro operativo porque suele acumular ruido.</p>
              {clickupTasksByStatus.length ? (
                <div className="clickup-board">
                  {clickupTasksByStatus.map(([status, tasks]) => (
                    <article className="clickup-column" key={status}>
                      <div className="clickup-column-header">
                        <span>{status}</span>
                        <strong>{tasks.length}</strong>
                      </div>
                      <div className="clickup-task-list">
                        {tasks
                          .slice(
                            (clickupColumnPages[status] || 0) * tasksPerColumn,
                            ((clickupColumnPages[status] || 0) + 1) * tasksPerColumn,
                          )
                          .map((task) => {
                          const accent = task.tagDetails?.[0]?.bg || task.statusColor || "#8bc6c1";
                          return (
                          <a className="week-task" href={task.url} key={task.id} target="_blank" rel="noreferrer" style={{ borderLeftColor: accent }}>
                            <strong>{task.name}</strong>
                            <span className="week-task-tags">
                              {(task.tagDetails || []).slice(0, 3).map((tag) => (
                                <i className="week-tag" key={tag.name} style={{ backgroundColor: tag.bg ? `${tag.bg}22` : undefined, color: tag.bg || undefined }}>
                                  {tag.name}
                                </i>
                              ))}
                            </span>
                            <span className="week-task-foot">
                              <i className="week-status-dot" style={{ backgroundColor: task.statusColor || "#9db0aa" }} />
                              <small>{task.dueDate ? shortDate(task.dueDate) : task.status}</small>
                              <span className="week-avatars">
                                {(task.assignees || []).slice(0, 3).map((person) => (
                                  <b key={`${task.id}-${person.id || person.initials || person.email}`} style={{ backgroundColor: person.color || "#054372" }} title={person.username || ""}>
                                    {(person.initials || person.username || "?").slice(0, 2).toUpperCase()}
                                  </b>
                                ))}
                              </span>
                            </span>
                          </a>
                          );
                        })}
                      </div>
                      {tasks.length > tasksPerColumn ? (
                        <div className="column-pager">
                          <button
                            className="secondary-button"
                            disabled={(clickupColumnPages[status] || 0) === 0}
                            onClick={() => setClickupColumnPages((current) => ({
                              ...current,
                              [status]: Math.max(0, (current[status] || 0) - 1),
                            }))}
                          >
                            Anterior
                          </button>
                          <span>
                            {(clickupColumnPages[status] || 0) + 1} / {Math.ceil(tasks.length / tasksPerColumn)}
                          </span>
                          <button
                            className="secondary-button"
                            disabled={(clickupColumnPages[status] || 0) >= Math.ceil(tasks.length / tasksPerColumn) - 1}
                            onClick={() => setClickupColumnPages((current) => ({
                              ...current,
                              [status]: Math.min(Math.ceil(tasks.length / tasksPerColumn) - 1, (current[status] || 0) + 1),
                            }))}
                          >
                            Siguiente
                          </button>
                        </div>
                      ) : null}
                    </article>
                  ))}
                </div>
              ) : (
                <p className="muted-copy">Aun no hay tareas cargadas desde ClickUp. Verifica la conexion y actualiza tareas.</p>
              )}
            </section>
          </section>
        ) : null}

        {activeView === "reports" ? (
        <section className="panel reports-tray">
          <div className="reports-toolbar">
            <div>
              <h2>Historial de reportes</h2>
              <small>{reportRows.length} de {visibleReports.length} reportes</small>
            </div>
            <div className="reports-controls">
              <input
                placeholder="Buscar por restaurante o periodo..."
                value={reportSearch}
                onChange={(event) => setReportSearch(event.target.value)}
              />
              <select value={reportStatusFilter} onChange={(event) => setReportStatusFilter(event.target.value)}>
                <option value="Todos">Todos los estados</option>
                <option value="Borrador">Borrador</option>
                <option value="Listo para revisar">Listo para revisar</option>
                <option value="Enviado">Enviado</option>
              </select>
            </div>
          </div>
          <div className="report-table">
            {pagedReportRows.map((report) => (
              <div className="report-row" key={report.id}>
                <div className="report-row-main">
                  <strong>{report.client?.name || report.clientId}</strong>
                  <small>{report.period?.label || report.periodId}</small>
                </div>
                <span className={statusClass(report.status)}>{report.status}</span>
                <div className="report-row-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      setSelectedClientId(report.clientId);
                      setSelectedPeriodId(report.periodId);
                      setSelectedReport(report);
                      setCommentsDraft(report.comments || "");
                      setEmailDraft(report.emailDraft || "");
                      setActiveView("module1");
                    }}
                  >
                    Abrir
                  </button>
                  <a className="button-link" href={`/api/module1/reports/${report.id}/export`} target="_blank" rel="noreferrer">
                    <Printer size={15} /> PDF
                  </a>
                </div>
              </div>
            ))}
            {!reportRows.length ? (
              <div className="empty-state">
                <strong>{visibleReports.length ? "No hay reportes que coincidan" : "Aún no hay reportes generados"}</strong>
                <small>
                  {reports.length
                    ? "Ajusta la búsqueda o el filtro de estado."
                    : "Elige un restaurante y un periodo para generar el primero."}
                </small>
                {!visibleReports.length ? (
                  <button className="primary-button" onClick={() => navigateTo("module1")}>
                    <Database size={16} /> Generar tu primer reporte
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          {reportRows.length > REPORTS_PER_PAGE ? (
            <div className="pager">
              <span className="pager-info">
                Mostrando {currentReportPage * REPORTS_PER_PAGE + 1}-{Math.min((currentReportPage + 1) * REPORTS_PER_PAGE, reportRows.length)} de {reportRows.length} reportes
              </span>
              <div className="pager-controls">
                <button
                  className="pager-nav"
                  disabled={currentReportPage === 0}
                  onClick={() => setReportPage(currentReportPage - 1)}
                >
                  Anterior
                </button>
                {Array.from({ length: reportPageCount }, (_, index) => index)
                  .filter((index) => Math.abs(index - currentReportPage) <= 2 || index === 0 || index === reportPageCount - 1)
                  .map((index, position, list) => (
                    <React.Fragment key={index}>
                      {position > 0 && list[position - 1] !== index - 1 ? <span className="pager-gap">…</span> : null}
                      <button
                        className={`pager-number ${index === currentReportPage ? "active" : ""}`}
                        onClick={() => setReportPage(index)}
                      >
                        {index + 1}
                      </button>
                    </React.Fragment>
                  ))}
                <button
                  className="pager-nav"
                  disabled={currentReportPage >= reportPageCount - 1}
                  onClick={() => setReportPage(currentReportPage + 1)}
                >
                  Siguiente
                </button>
              </div>
            </div>
          ) : null}
        </section>
        ) : null}

        {activeView === "users" ? (
          <section className="users-view">
            <div className="users-header">
              <div>
                <h2>Usuarios</h2>
                <p>Gestiona usuarios del CMS y sus permisos de acceso.</p>
              </div>
              <button className="primary-button" onClick={openCreateUserModal}><Plus size={17} /> Nuevo usuario</button>
            </div>
            <div className="users-list">
              {cmsUsers.map((user) => (
                <article className="user-card" key={user.id}>
                  <div className="user-avatar">
                    {(user.name || user.email || "U").slice(0, 1).toUpperCase()}
                    <span className={`presence-dot presence-badge presence-${user.presence || "disponible"}`} />
                  </div>
                  <div className="user-main">
                    <div className="user-title-row">
                      <strong>{user.name || user.email}</strong>
                      <span className="user-role-chip">{user.role || "Usuario"}</span>
                      <span className="user-presence">
                        {presenceOptions.find((option) => option.id === (user.presence || "disponible"))?.label || "Disponible"}
                      </span>
                    </div>
                    <small>{user.email || "Sin email"}</small>
                    <div className="permission-chips">
                      {userPermissionOptions.map((option) => {
                        const enabled = user.role === "Superadmin" || user.permissions.includes(option.id);
                        return (
                          <span className={`permission-chip ${enabled ? "enabled" : "denied"}`} key={`${user.id}-${option.id}`}>
                            {option.label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="user-actions">
                    {isSystemUser(user) ? (
                      <span className="system-user-note">Acceso total</span>
                    ) : (
                      <>
                        <button className="secondary-button" onClick={() => openEditUserModal(user)}>Editar</button>
                        <button className="link-danger" onClick={() => deleteUser(user.id)}>Eliminar</button>
                      </>
                    )}
                  </div>
                </article>
              ))}
              {!cmsUsers.length ? (
                <div className="empty-state">
                  <strong>No hay usuarios cargados</strong>
                  <small>Crea el primer usuario operativo para asignar permisos por modulo.</small>
                </div>
              ) : null}
            </div>
          </section>
        ) : null}

        {activeView === "criteria" ? (
          <section className="page-grid">
            <div className="panel">
              <div className="upload-box criteria-uploader">
                <label>
                  Cliente de la skill
                  <select value={criteriaClientId} onChange={(event) => setCriteriaClientId(event.target.value)}>
                    <option value="">General (todos los clientes)</option>
                    {(sculptureUnits.filter((unit) => !unit.hidden).length
                      ? sculptureUnits.filter((unit) => !unit.hidden).map((unit) => ({ id: unit.id, name: unit.name }))
                      : clients.map((client) => ({ id: client.id, name: clientDisplayName(client) }))
                    ).map((option) => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Archivos de criterio
                  <input
                    accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json"
                    multiple
                    type="file"
                    onChange={(event) => setSelectedCriteriaFiles(Array.from(event.target.files || []))}
                  />
                </label>
                {selectedCriteriaFiles.length ? (
                  <div className="selected-files">
                    {selectedCriteriaFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
                  </div>
                ) : (
                  <small>Sube guias internas, criterios de analisis, ejemplos de comentarios o reglas comerciales del equipo.</small>
                )}
                <div className="upload-actions">
                  <button
                    className="primary-button"
                    disabled={!selectedCriteriaFiles.length || workStatus === "loading"}
                    onClick={() => importCriteriaFiles()}
                  >
                    <Upload size={17} /> {workStatus === "loading" ? "Cargando criterios..." : "Cargar criterios"}
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!selectedCriteriaFiles.length || workStatus === "loading"}
                    onClick={() => setSelectedCriteriaFiles([])}
                  >
                    Limpiar seleccion
                  </button>
                </div>
                <small>Estos documentos quedan guardados en la biblioteca del CMS y el agente los usa al generar el resumen del reporte.</small>
              </div>

              <div className="upload-box bulk-block-box">
                <div>
                  <p className="eyebrow">Actualización masiva</p>
                  <strong>Aplicar un bloque a varios criterios de una vez</strong>
                  <small>Se agrega al final de cada criterio como bloque con nombre. Re-aplicarlo con el mismo título lo reemplaza, sin duplicar.</small>
                </div>
                <label>
                  Título del bloque
                  <input
                    placeholder="Ej. Formato de comentarios 2026"
                    value={bulkBlock.title}
                    onChange={(event) => setBulkBlock((current) => ({ ...current, title: event.target.value }))}
                  />
                </label>
                <label>
                  Contenido (instrucciones / prompt)
                  <textarea
                    placeholder="Las instrucciones que quieres que TODOS los criterios incluyan..."
                    rows={5}
                    value={bulkBlock.text}
                    onChange={(event) => setBulkBlock((current) => ({ ...current, text: event.target.value }))}
                  />
                </label>
                <label>
                  Aplicar a
                  <select
                    value={bulkBlock.target === "client" ? `client:${bulkBlock.clientId}` : bulkBlock.target}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value.startsWith("client:")) setBulkBlock((current) => ({ ...current, target: "client", clientId: value.slice(7) }));
                      else setBulkBlock((current) => ({ ...current, target: value, clientId: "" }));
                    }}
                  >
                    <option value="all">Todos los criterios</option>
                    <option value="general">Solo los generales</option>
                    {clients.map((client) => (
                      <option key={client.id} value={`client:${client.id}`}>Solo {clientDisplayName(client)}</option>
                    ))}
                  </select>
                </label>
                <div className="upload-actions">
                  <button
                    className="primary-button"
                    disabled={!bulkBlock.title.trim() || !bulkBlock.text.trim() || bulkSaving}
                    onClick={applyBulkBlock}
                  >
                    {bulkSaving ? <span className="btn-spinner" /> : <Upload size={17} />}
                    {bulkSaving ? "Aplicando..." : "Aplicar a los criterios"}
                  </button>
                </div>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Biblioteca</p>
                  <h2>Criterios disponibles</h2>
                </div>
                <FileText size={22} />
              </div>
              <p className="muted-copy">La biblioteca funciona como memoria operativa: mientras mas criterios reales carguen, mas consistente sera la lectura del reporte semanal.</p>
              <div className="criteria-doc-list">
                {criteriaDocuments.length ? criteriaDocuments.map((document) => (
                  <article key={document.id}>
                    <div>
                      <div className="criteria-doc-title">
                        <span className={`criteria-client-chip ${document.clientId ? "" : "is-general"}`}>
                          {document.clientName || "General"}
                        </span>
                        <strong>{document.name}</strong>
                        {document.source ? (
                          <span className={`criteria-source ${document.source.startsWith("chatgpt") ? "chatgpt" : ""}`}>
                            {document.source === "chatgpt-api" ? "Importado con IA" : document.source === "chatgpt" ? "ChatGPT" : "Manual"}
                          </span>
                        ) : null}
                      </div>
                      <small>
                        {new Date(document.uploadedAt).toLocaleDateString("es-CL")} - {Math.max(1, Math.round(document.size / 1024))} KB
                        {document.category ? ` - ${document.category.replaceAll("_", " ")}` : ""}
                      </small>
                      <p>{document.text.slice(0, 240)}{document.text.length > 240 ? "..." : ""}</p>
                    </div>
                    <div className="criteria-doc-actions">
                      <button
                        aria-label={`Editar ${document.name}`}
                        className="icon-button"
                        disabled={workStatus === "loading"}
                        onClick={() => setEditingCriteria({ ...document })}
                      >
                        <PencilLine size={16} />
                      </button>
                      <button
                        aria-label={`Eliminar ${document.name}`}
                        className="icon-button"
                        disabled={workStatus === "loading"}
                        onClick={() => deleteCriteriaDocument(document.id)}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                )) : (
                  <p className="muted-copy">Aun no hay criterios cargados. Sube el primer archivo para que el agente empiece a usar esa informacion.</p>
                )}
              </div>
            </div>
          </section>
        ) : null}

        {editingCriteria ? (
          <div className="modal-backdrop" role="presentation">
            <section className="user-modal criteria-modal" role="dialog" aria-modal="true" aria-labelledby="criteria-modal-title">
              <button className="modal-close icon-button" aria-label="Cerrar" onClick={() => setEditingCriteria(null)}>
                <X size={16} />
              </button>
              <h2 id="criteria-modal-title">Editar criterio</h2>
              <label>
                Nombre
                <input
                  value={editingCriteria.name}
                  onChange={(event) => setEditingCriteria((current) => (current ? { ...current, name: event.target.value } : current))}
                />
              </label>
              <label>
                Cliente asignado
                <select
                  value={editingCriteria.clientId || ""}
                  onChange={(event) => {
                    const clientId = event.target.value;
                    const client = clients.find((item) => item.id === clientId);
                    setEditingCriteria((current) => (current ? { ...current, clientId, clientName: client ? clientDisplayName(client) : "" } : current));
                  }}
                >
                  <option value="">General (todos los clientes)</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>{clientDisplayName(client)}</option>
                  ))}
                </select>
              </label>
              <label>
                Conocimiento / prompt
                <textarea
                  className="criteria-editor"
                  rows={16}
                  value={editingCriteria.text}
                  onChange={(event) => setEditingCriteria((current) => (current ? { ...current, text: event.target.value } : current))}
                />
              </label>
              <div className="modal-actions">
                <button className="secondary-button" type="button" onClick={() => setEditingCriteria(null)}>Cancelar</button>
                <button className="primary-button" disabled={workStatus === "loading"} type="button" onClick={saveCriteriaEdit}>
                  {workStatus === "loading" ? <span className="btn-spinner" /> : <PencilLine size={17} />} Guardar cambios
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {userModalOpen ? (
          <div className="modal-backdrop" role="presentation">
            <section className="user-modal" role="dialog" aria-modal="true" aria-labelledby="user-modal-title">
              <button className="modal-close icon-button" aria-label="Cerrar" onClick={() => setUserModalOpen(false)}>
                <X size={17} />
              </button>
              <form onSubmit={saveUser}>
                <h2 id="user-modal-title">{editingUserId ? "Editar usuario" : "Crear nuevo usuario"}</h2>
                <label>
                  Nombre
                  <input required value={userForm.name} onChange={(event) => setUserForm((current) => ({ ...current, name: event.target.value }))} />
                </label>
                <label>
                  Email
                  <input required type="email" value={userForm.email} onChange={(event) => setUserForm((current) => ({ ...current, email: event.target.value }))} />
                </label>
                <label>
                  Contraseña
                  <input
                    minLength={editingUserId ? undefined : 6}
                    placeholder={editingUserId ? "Dejar vacía para no cambiar" : "Mínimo 6 caracteres"}
                    required={!editingUserId}
                    type="password"
                    value={userForm.password}
                    onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                  />
                </label>
                <label>
                  Rol
                  <select value={userForm.role} onChange={(event) => setUserForm((current) => ({ ...current, role: event.target.value }))}>
                    {roleOptions.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                </label>
                <div className="permission-editor">
                  <strong>Permisos de acceso a módulos</strong>
                  {userPermissionOptions.map((permission) => {
                    const checked = userForm.permissions.includes(permission.id);
                    return (
                      <label className="toggle-row" key={permission.id}>
                        <span>{permission.label}</span>
                        <input
                          checked={checked}
                          type="checkbox"
                          onChange={(event) => setUserForm((current) => ({
                            ...current,
                            permissions: event.target.checked
                              ? Array.from(new Set([...current.permissions, permission.id]))
                              : current.permissions.filter((item) => item !== permission.id),
                          }))}
                        />
                        <i aria-hidden="true" />
                      </label>
                    );
                  })}
                </div>
                <p className="modal-help">El usuario configurado en variables de entorno siempre conserva acceso total como superadmin.</p>
                <div className="modal-actions">
                  <button className="secondary-button" type="button" onClick={() => setUserModalOpen(false)}>Cancelar</button>
                  <button className="primary-button" disabled={workStatus === "loading"} type="submit">
                    {editingUserId ? "Guardar cambios" : "Crear usuario"}
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : null}

      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

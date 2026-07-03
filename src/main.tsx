import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  BarChart3,
  Bot,
  Building2,
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
type AuthStatus = "checking" | "authenticated" | "anonymous";
type WorkStatus = "idle" | "loading" | "ready" | "error";
type ActiveView = "dashboard" | "module1" | "tasks" | "reports" | "criteria" | "users";
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
  updatedAt: string;
  client?: Client;
  period?: Period;
  history: HistoryPoint[];
  summary: {
    revenue: number;
    costPercent: number;
    variancePercent: number;
    varianceAmount: number;
  };
  categoryVariances: Array<{ category: string; amount: number; percent: number }>;
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

function statusClass(status: ReportStatus) {
  if (status === "Enviado") return "pill success";
  if (status === "Listo para revisar") return "pill warning";
  return "pill neutral";
}

async function readJson<T>(response: Response): Promise<T> {
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
  const [criteriaClientId, setCriteriaClientId] = useState("");
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null);
  const [selectedCriteriaFiles, setSelectedCriteriaFiles] = useState<File[]>([]);
  const [selectedChatGptFiles, setSelectedChatGptFiles] = useState<File[]>([]);
  const [chatGptImport, setChatGptImport] = useState({
    projectName: "",
    instructions: "",
    reportPrompt: "",
    examples: "",
    notes: "",
  });
  const [sculptureUnits, setSculptureUnits] = useState<SculptureUnit[]>([]);
  const [sculpturePeriods, setSculpturePeriods] = useState<SculpturePeriod[]>([]);
  const [selectedSculptureUnitId, setSelectedSculptureUnitId] = useState("");
  const [sculptureDirectoryLoaded, setSculptureDirectoryLoaded] = useState(false);
  const [fromMonth, setFromMonth] = useState("");
  const [toMonth, setToMonth] = useState("");
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
    const selectedMonth = monthFromPeriod(report?.period || payload.periods[0]);
    if (selectedMonth) {
      setFromMonth((current) => current || selectedMonth);
      setToMonth((current) => current || selectedMonth);
    }
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
      const firstMonth = monthFromPeriod(periodsFromSculpture[0]);
      if (firstMonth) {
        setFromMonth((current) => current || firstMonth);
        setToMonth((current) => current || firstMonth);
      }
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
      const latestMonth = monthFromPeriod(periods[0]);
      if (latestMonth) {
        setFromMonth(latestMonth);
        setToMonth(latestMonth);
      }
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
            fromMonth,
            toMonth,
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
          body: JSON.stringify({ files: encodedFiles, clientId: criteriaClientId }),
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

  async function importChatGptProject() {
    const projectName = chatGptImport.projectName.trim() || "Proyecto ChatGPT";
    const totalSize = selectedChatGptFiles.reduce((sum, file) => sum + file.size, 0) +
      chatGptImport.instructions.length +
      chatGptImport.reportPrompt.length +
      chatGptImport.examples.length +
      chatGptImport.notes.length;

    if (
      !chatGptImport.instructions.trim() &&
      !chatGptImport.reportPrompt.trim() &&
      !chatGptImport.examples.trim() &&
      !chatGptImport.notes.trim() &&
      !selectedChatGptFiles.length
    ) {
      setError("Pega instrucciones, prompts, ejemplos o sube archivos descargados de ChatGPT.");
      setWorkStatus("error");
      return;
    }

    if (totalSize > 5 * 1024 * 1024) {
      setError("La importacion desde ChatGPT supera 5 MB. Divide el contenido por proyecto o por tema.");
      setWorkStatus("error");
      return;
    }

    setWorkStatus("loading");
    setError("Procesando contenido con OpenAI y guardándolo en la biblioteca...");

    try {
      const fileDocuments = await Promise.all(
        selectedChatGptFiles.map(async (file) => ({
          name: file.name,
          type: file.type || "text/plain",
          size: file.size,
          text: await file.text(),
        })),
      );
      const payload = await readJson<BootstrapPayload & { importSummary?: string; importedCount?: number }>(
        await fetch("/api/module1/criteria-documents/import-chatgpt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            projectName,
            clientId: criteriaClientId,
            instructions: chatGptImport.instructions,
            reportPrompt: chatGptImport.reportPrompt,
            examples: chatGptImport.examples,
            notes: chatGptImport.notes,
            files: fileDocuments,
          }),
        }),
      );
      applyBootstrapPayload(payload);
      setSelectedChatGptFiles([]);
      setChatGptImport({ projectName: "", instructions: "", reportPrompt: "", examples: "", notes: "" });
      setError(`${payload.importedCount || 0} criterio(s) importado(s) con OpenAI. ${payload.importSummary || "El agente los usara al generar reportes."}`);
      setWorkStatus("ready");
    } catch (criteriaError) {
      setError(criteriaError instanceof Error ? criteriaError.message : "No se pudo importar contenido desde ChatGPT con OpenAI.");
      setWorkStatus("error");
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
    document.documentElement.dataset.theme = themeMode;
    localStorage.setItem("bevinco-theme", themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!error || workStatus === "loading") return;
    const timer = setTimeout(() => setError(""), workStatus === "error" ? 9000 : 5500);
    return () => clearTimeout(timer);
  }, [error, workStatus]);

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
        detail: `Falta revisar: ${item.missingSources.map((key) => sourceLabels[key]).join(", ")}.`,
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

    return {
      reportsWithSources,
      blockedReports,
      draftReports,
      readyReports,
      sentReports,
      highVarianceReports,
      dueTasks,
      attentionItems,
    };
  }, [reports, clickupTasks]);
  const maxRevenue = Math.max(...(selectedReport?.history.map((item) => item.revenue) || [1]), 1);
  const maxAbsVariance = Math.max(...(selectedReport?.history.map((item) => Math.abs(item.varianceAmount)) || [1]), 1);
  const maxCategoryVariance = Math.max(...(selectedReport?.categoryVariances.map((item) => Math.abs(item.amount)) || [1]), 1);
  const maxProductVariance = Math.max(...(selectedReport?.topProducts.map((item) => Math.abs(item.varianceAmount)) || [1]), 1);
  const selectedClient = clients.find((client) => client.id === selectedClientId) || selectedReport?.client || null;
  const selectedUnitInfo = sculptureUnits.find((item) => item.id === selectedSculptureUnitId) || null;
  const viewMeta = {
    dashboard: ["CMS operativo", "Reportes Bevinco/Sculpture"],
    module1: ["Operación semanal", "Reportes semanales"],
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
                <p className="eyebrow">Operacion semanal</p>
                <h2>Prioriza reportes, datos faltantes y envíos desde una sola vista.</h2>
              </div>
              <div className="dashboard-hero-actions">
                <button className="primary-button" onClick={() => setActiveView("module1")}><ClipboardList size={17} /> Generar reporte</button>
                <button className="secondary-button" onClick={() => setActiveView("tasks")}><ListChecks size={17} /> Ver pendientes</button>
              </div>
            </section>

            <section className="dashboard-kpis" aria-label="Resumen operativo">
              <button className="kpi-card" onClick={() => { setReportStatusFilter("Todos"); navigateTo("reports"); }}>
                <span className="kpi-icon"><FileText size={18} /></span>
                <span className="kpi-body">
                  <small className="kpi-label">Reportes</small>
                  <strong>{reports.length}</strong>
                  <small className="kpi-sub">{dashboardSummary.sentReports.length} enviados</small>
                </span>
              </button>
              <button className="kpi-card" onClick={() => navigateTo("module1")}>
                <span className="kpi-icon kpi-icon-warn"><Cloud size={18} /></span>
                <span className="kpi-body">
                  <small className="kpi-label">Datos por revisar</small>
                  <strong>{dashboardSummary.blockedReports.length}</strong>
                  <small className="kpi-sub">Faltan datos de la auditoría</small>
                </span>
              </button>
              <button className="kpi-card" onClick={() => { setReportStatusFilter("Listo para revisar"); navigateTo("reports"); }}>
                <span className="kpi-icon kpi-icon-info"><PencilLine size={18} /></span>
                <span className="kpi-body">
                  <small className="kpi-label">En revisión</small>
                  <strong>{dashboardSummary.readyReports.length}</strong>
                  <small className="kpi-sub">{dashboardSummary.draftReports.length} borradores</small>
                </span>
              </button>
              <button className="kpi-card" onClick={() => navigateTo("tasks")}>
                <span className="kpi-icon kpi-icon-teal"><ListChecks size={18} /></span>
                <span className="kpi-body">
                  <small className="kpi-label">ClickUp</small>
                  <strong>{clickupTasks.length}</strong>
                  <small className="kpi-sub">{clickupStatus?.connected ? "Conectado" : "Sin conexión"}</small>
                </span>
              </button>
            </section>

            <section className="dashboard-focus">
              <div className="panel attention-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Atención hoy</p>
                    <h2>Próximas acciones</h2>
                  </div>
                  <Bot size={22} />
                </div>
                <div className="attention-list">
                  {dashboardSummary.attentionItems.length ? dashboardSummary.attentionItems.map((item) => (
                    <button key={item.id} onClick={item.onClick}>
                      <span>
                        <strong>{item.title}</strong>
                        <small>{item.meta}</small>
                        <em>{item.detail}</em>
                      </span>
                      <b>{item.action}</b>
                    </button>
                  )) : (
                    <div className="empty-state">
                      <strong>Sin bloqueos visibles</strong>
                      <small>Los reportes están al día, sin revisiones urgentes.</small>
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="dashboard-grid dashboard-grid-bottom">
              <div className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Variaciones</p>
                    <h2>Reportes con mayor impacto</h2>
                  </div>
                  <BarChart3 size={22} />
                </div>
                <div className="impact-list">
                  {dashboardSummary.highVarianceReports.length ? dashboardSummary.highVarianceReports.map((report) => (
                    <button
                      key={report.id}
                      onClick={() => {
                        setSelectedClientId(report.clientId);
                        setSelectedPeriodId(report.periodId);
                        setSelectedReport(report);
                        setCommentsDraft(report.comments || "");
                        setEmailDraft(report.emailDraft || "");
                        setActiveView("module1");
                      }}
                    >
                      <span>
                        <strong>{report.client?.name || report.clientId}</strong>
                        <small>{report.period?.label || report.periodId}</small>
                      </span>
                      <b className={(report.summary?.varianceAmount || 0) < 0 ? "bad-text" : "ok-text"}>{money(report.summary?.varianceAmount || 0)}</b>
                    </button>
                  )) : <p className="muted-copy">Aún no hay variaciones relevantes en los reportes cargados.</p>}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Pendientes ClickUp</p>
                    <h2>Fechas cercanas</h2>
                  </div>
                  <ListChecks size={22} />
                </div>
                <div className="due-list">
                  {dashboardSummary.dueTasks.length ? dashboardSummary.dueTasks.map((task) => (
                    <a href={task.url} key={task.id} target="_blank" rel="noreferrer">
                      <span>
                        <strong>{task.name}</strong>
                        <small>{task.status}</small>
                      </span>
                      <b>{shortDate(task.dueDate)}</b>
                    </a>
                  )) : <p className="muted-copy">No hay tareas con fecha límite cargadas en esta vista.</p>}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Últimos reportes</p>
                    <h2>Bandeja reciente</h2>
                  </div>
                  <FileText size={22} />
                </div>
                <div className="recent-report-list">
                  {reports.slice(0, 5).map((report) => (
                    <button
                      key={report.id}
                      onClick={() => {
                        setSelectedClientId(report.clientId);
                        setSelectedPeriodId(report.periodId);
                        setSelectedReport(report);
                        setCommentsDraft(report.comments || "");
                        setEmailDraft(report.emailDraft || "");
                        setActiveView("module1");
                      }}
                    >
                      <span>
                        <strong>{report.client?.name || report.clientId}</strong>
                        <small>{report.period?.label || report.periodId}</small>
                      </span>
                      <i className={statusClass(report.status)}>{report.status}</i>
                    </button>
                  ))}
                </div>
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
                <span>Unidad / módulo</span>
                <strong>{selectedUnitInfo?.moduleName || clientUnitLabel(selectedClient)}</strong>
              </article>
              {isAdminUser(currentUserInfo) ? (
                <article>
                  <span>Sculpture CID</span>
                  <strong>{selectedUnitInfo?.sculptureCid || selectedClient?.sculptureCid || selectedClient?.cid || "Por configurar"}</strong>
                </article>
              ) : null}
              <article>
                <span>Área</span>
                <strong>{selectedUnitInfo?.area || selectedClient?.area || "Food"}</strong>
              </article>
              {isAdminUser(currentUserInfo) ? (
                <article>
                  <span>Origen</span>
                  <strong>{(selectedUnitInfo?.baseUrl || selectedClient?.sculptureBaseUrl || "").includes("beverage") ? "Beverage" : "Food"}</strong>
                </article>
              ) : null}
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
                          ? `Todos los del rango de meses (${clientPeriods.length} disponibles)`
                          : "Selecciona un restaurante para ver sus periodos"}
                    </option>
                    {clientPeriods.map((period) => (
                      <option key={period.id} value={period.id}>
                        {period.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Desde mes
                  <input
                    type="month"
                    value={fromMonth}
                    onChange={(event) => setFromMonth(event.target.value)}
                  />
                </label>
                <label>
                  Hasta mes
                  <input
                    type="month"
                    value={toMonth}
                    onChange={(event) => setToMonth(event.target.value)}
                  />
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


        <section className="metrics" aria-label="Resumen">
          <article>
            <span><FileSpreadsheet size={18} /> Ingresos</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : money(selectedReport?.summary.revenue || 0)}</strong>
            <small>{selectedReport?.period?.label || "Sin periodo"}</small>
          </article>
          <article>
            <span><BarChart3 size={18} /> % costo</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : `${selectedReport?.summary.costPercent || 0}%`}</strong>
            <small>Food cost / pour cost</small>
          </article>
          <article>
            <span><FileText size={18} /> Variance</span>
            <strong>{workStatus === "loading" ? <span className="skeleton" /> : `${selectedReport?.summary.variancePercent || 0}%`}</strong>
            <small>{workStatus === "loading" ? "Actualizando..." : money(selectedReport?.summary.varianceAmount || 0)}</small>
          </article>
          <article>
            <span><ListChecks size={18} /> Estado</span>
            <strong className="metric-status">{selectedReport?.status || "Borrador"}</strong>
            <small>{workStatus === "loading" ? "Actualizando" : "Operativo"}</small>
          </article>
        </section>

        {accumulatedReport ? (
          <section className="panel accumulated-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Acumulado mensual</p>
                <h2>{accumulatedReport.period?.label || "Acumulado de periodos"}</h2>
              </div>
              <FileSpreadsheet size={22} />
            </div>
            <p className="query-note accumulated-note">
              Ingresos, ventas y variación se suman entre periodos; las existencias/stock toman el último periodo, como en Sculpture.
            </p>
            <div className="metrics accumulated-metrics">
              <article>
                <span><FileSpreadsheet size={18} /> Ingresos (suma)</span>
                <strong>{money(accumulatedReport.summary.revenue || 0)}</strong>
                <small>{accumulatedReport.includedPeriods.length} periodo(s)</small>
              </article>
              <article>
                <span><BarChart3 size={18} /> % costo</span>
                <strong>{accumulatedReport.summary.costPercent || 0}%</strong>
                <small>Sobre ingresos acumulados</small>
              </article>
              <article>
                <span><FileText size={18} /> Variance (suma)</span>
                <strong>{accumulatedReport.summary.variancePercent || 0}%</strong>
                <small>{money(accumulatedReport.summary.varianceAmount || 0)}</small>
              </article>
              <article>
                <span><ListChecks size={18} /> Stock</span>
                <strong className="metric-status">Último periodo</strong>
                <small>{accumulatedReport.purchaseSuggestions.length} artículo(s)</small>
              </article>
            </div>
            <div className="accumulated-periods">
              {accumulatedReport.includedPeriods.map((period) => (
                <span key={period.id} className="accumulated-chip">{period.label}</span>
              ))}
            </div>
          </section>
        ) : null}

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

        {isAdminUser(currentUserInfo) ? (
        <section className="module-grid" id="sources">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Diagnóstico (solo admin)</p>
                <h2>Estado de los datos de la auditoría</h2>
              </div>
              <Cloud size={22} />
            </div>
            <div className="source-grid">
              {Object.entries(sourceLabels).map(([key, label]) => (
                <article key={key}>
                  <strong>{label}</strong>
                  <span className={["Sincronizado", "Datos cargados"].includes(selectedReport?.sourceStatus[key] || "") ? "pill success" : "pill neutral"}>
                    {selectedReport?.sourceStatus[key] || "Por revisar"}
                  </span>
                </article>
              ))}
            </div>
          </div>

        </section>
        ) : null}

        <section className="panel actions-bar">
          <div>
            <p className="eyebrow">Acciones</p>
            <h2>Revisión y envío</h2>
          </div>
          <div className="action-row wrap-actions">
            <button className="secondary-button" onClick={() => selectedReport && saveReport({ status: "Borrador" })}>Marcar borrador</button>
            <button className="secondary-button" onClick={() => selectedReport && saveReport({ status: "Listo para revisar" })}>Listo para revisar</button>
            <button className="primary-button" onClick={sendEmail}><Send size={17} /> Preparar/enviar email</button>
          </div>
        </section>

        <section className="split-section">
          <div className="panel">
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
          </div>

          <div className="panel" id="comments">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Reporte generado</p>
                <h2>Resumen ejecutivo para cliente</h2>
              </div>
              <Bot size={22} />
            </div>
            <div className="summary-help">
              <strong>Generador de reporte</strong>
              <small>Arma el resumen ejecutivo y el correo con los datos de la semana, y guarda el reporte en la bandeja del Historial.</small>
            </div>
            <textarea aria-label="Resumen ejecutivo" value={commentsDraft} onChange={(event) => setCommentsDraft(event.target.value)} />
            <textarea aria-label="Cuerpo del email" value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} />
            <div className="action-row wrap-actions">
              <button className="secondary-button" disabled={!selectedReport || workStatus === "loading"} onClick={generateSummary}>
                {workStatus === "loading" ? <span className="btn-spinner btn-spinner-dark" /> : <Bot size={17} />}
                {workStatus === "loading" ? "Generando..." : "Generar reporte"}
              </button>
              <button className="primary-button" onClick={() => saveReport({ comments: commentsDraft, emailDraft })}>
                <PencilLine size={17} /> Guardar cambios
              </button>
            </div>
          </div>
        </section>

        <section className="module-grid">
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Variance</p>
                <h2>Variaciones por categoría</h2>
              </div>
            </div>
            <div className="variance-chart">
              {selectedReport?.categoryVariances.map((item) => (
                <article key={item.category}>
                  <div>
                    <strong>{item.category}</strong>
                    <span className={item.amount < 0 ? "negative" : "positive"}>{money(item.amount)} - {item.percent}%</span>
                  </div>
                  <div className="chart-track">
                    <div
                      className={item.amount < 0 ? "negative-bar" : "positive-bar"}
                      style={{ width: `${Math.max(8, (Math.abs(item.amount) / maxCategoryVariance) * 100)}%` }}
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
            <ShoppingCart size={22} />
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
                          .map((task) => (
                          <a className="clickup-task-card" href={task.url} key={task.id} target="_blank" rel="noreferrer">
                            <div className="clickup-task-main">
                              <strong>{task.name}</strong>
                              <small>{shortDate(task.dueDate)}</small>
                            </div>
                            <div className="clickup-task-meta">
                              {task.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}
                              {task.assignees.slice(0, 3).map((assignee) => (
                                <i key={`${task.id}-${assignee.id || assignee.initials || assignee.email}`}>
                                  {assignee.initials || assignee.username?.slice(0, 2) || "CU"}
                                </i>
                              ))}
                            </div>
                          </a>
                        ))}
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
            <div className="panel chatgpt-import-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Importar desde ChatGPT</p>
                  <h2>Procesar criterios con OpenAI</h2>
                </div>
                <Bot size={22} />
              </div>
              <p className="muted-copy">Pega instrucciones, prompts o ejemplos del Project. OpenAI los ordena como criterios y el CMS los guarda en la biblioteca que alimenta los reportes.</p>
              <div className="chatgpt-import-grid">
                <label>
                  Nombre del proyecto
                  <input
                    placeholder="Ej. Bevinco reportes semanales"
                    value={chatGptImport.projectName}
                    onChange={(event) => setChatGptImport((current) => ({ ...current, projectName: event.target.value }))}
                  />
                </label>
                <label>
                  Instrucciones del Project
                  <textarea
                    placeholder="Pega aqui las instrucciones del proyecto de ChatGPT..."
                    value={chatGptImport.instructions}
                    onChange={(event) => setChatGptImport((current) => ({ ...current, instructions: event.target.value }))}
                  />
                </label>
                <label>
                  Prompt de reporte semanal
                  <textarea
                    placeholder="Pega el prompt que usan para crear reportes..."
                    value={chatGptImport.reportPrompt}
                    onChange={(event) => setChatGptImport((current) => ({ ...current, reportPrompt: event.target.value }))}
                  />
                </label>
                <label>
                  Ejemplos de buenos comentarios
                  <textarea
                    placeholder="Pega comentarios buenos generados o corregidos por el equipo..."
                    value={chatGptImport.examples}
                    onChange={(event) => setChatGptImport((current) => ({ ...current, examples: event.target.value }))}
                  />
                </label>
                <label>
                  Notas, reglas o cuestionario operaciones
                  <textarea
                    placeholder="Pega reglas de costo ideal, compra sugerida, cuestionario de operaciones, etc."
                    value={chatGptImport.notes}
                    onChange={(event) => setChatGptImport((current) => ({ ...current, notes: event.target.value }))}
                  />
                </label>
                <label>
                  Archivos descargados de ChatGPT
                  <input
                    accept=".txt,.md,.csv,.json,.html,text/plain,text/markdown,text/csv,application/json,text/html"
                    multiple
                    type="file"
                    onChange={(event) => setSelectedChatGptFiles(Array.from(event.target.files || []))}
                  />
                </label>
              </div>
              {selectedChatGptFiles.length ? (
                <div className="selected-files">
                  {selectedChatGptFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}
                </div>
              ) : (
                <small className="muted-copy">Para export ZIP completo aun conviene extraer/copiar los archivos utiles antes de subirlos. PDFs/DOCX requieren un extractor adicional.</small>
              )}
              <div className="upload-actions">
                <button className="primary-button" disabled={workStatus === "loading"} onClick={importChatGptProject}>
                  <Bot size={17} /> Procesar e importar
                </button>
                <button
                  className="secondary-button"
                  disabled={workStatus === "loading"}
                  onClick={() => {
                    setSelectedChatGptFiles([]);
                    setChatGptImport({ projectName: "", instructions: "", reportPrompt: "", examples: "", notes: "" });
                  }}
                >
                  Limpiar
                </button>
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Alimentar al agente</p>
                  <h2>Subir criterios de reporte</h2>
                </div>
                <Upload size={22} />
              </div>
              <div className="upload-box criteria-uploader">
                <label>
                  Cliente (opcional)
                  <select value={criteriaClientId} onChange={(event) => setCriteriaClientId(event.target.value)}>
                    <option value="">General (todos los clientes)</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>{clientDisplayName(client)}</option>
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
                    <button
                      aria-label={`Eliminar ${document.name}`}
                      className="icon-button"
                      disabled={workStatus === "loading"}
                      onClick={() => deleteCriteriaDocument(document.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </article>
                )) : (
                  <p className="muted-copy">Aun no hay criterios cargados. Sube el primer archivo para que el agente empiece a usar esa informacion.</p>
                )}
              </div>
            </div>
          </section>
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

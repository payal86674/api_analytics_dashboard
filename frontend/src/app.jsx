/**
 * Micro-SaaS API Command Center  (React + Vite + Tailwind + Recharts)
 *
 * Install:   npm install axios lucide-react recharts
 * Optional:  create .env with  VITE_API_URL=http://127.0.0.1:8000/api
 *
 * Pages (no router package needed, navigation uses the URL hash):
 *   #/overview   KPIs, traffic trend, status codes, latency by endpoint
 *   #/endpoints  sortable, searchable endpoint table + CSV export
 *   #/logs       searchable request logs with filters and pagination
 *   #/cost       spend, monthly forecast, budget, caching simulator, insights
 *   #/limits     rate-limit simulator
 */
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import {
  Activity, Clock, AlertTriangle, DollarSign, RefreshCw, Server,
  TrendingUp, PieChart as PieIcon, Download, ShieldAlert, Sparkles,
  Layers, Sliders, Zap, Search, ChevronLeft, ChevronRight,
  LayoutDashboard, List, Wallet, Gauge, Info, Users, Calendar,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend,
} from 'recharts';

/* ------------------------------------------------------------------ */
/* Config + helpers                                                    */
/* ------------------------------------------------------------------ */
const API_BASE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_API_URL) ||
  'http://127.0.0.1:8000/api';

const api = axios.create({ baseURL: API_BASE_URL, timeout: 15000 });

const PAGES = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'endpoints', label: 'Endpoints', icon: Server },
  { id: 'logs', label: 'Request logs', icon: List },
  { id: 'cost', label: 'Cost and insights', icon: Wallet },
  { id: 'limits', label: 'Rate limits', icon: Gauge },
];

const TIER_OPTIONS = [
  { value: 'all', label: 'All tiers' },
  { value: 'free', label: 'Free tier' },
  { value: 'pro', label: 'Pro tier' },
  { value: 'enterprise', label: 'Enterprise tier' },
];

const RANGE_OPTIONS = [
  { value: 1, label: 'Last 24 hours' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
];

const STATUS_COLORS = { 200: '#10B981', 429: '#F59E0B', 500: '#EF4444' };
const FALLBACK_COLORS = ['#3B82F6', '#8B5CF6', '#EC4899', '#14B8A6', '#F97316'];

const TOOLTIP_STYLE = {
  contentStyle: { backgroundColor: '#1e293b', borderColor: '#475569', borderRadius: '0.5rem', color: '#e2e8f0' },
  labelStyle: { color: '#e2e8f0' },
  itemStyle: { color: '#cbd5e1' },
};

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const fmtInt = (value) => num(value).toLocaleString();

const fmtMoney = (value) => {
  const n = num(value);
  return `$${n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
};

const fmtDate = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
};

const statusColor = (name) => {
  const code = Number(String(name).replace(/\D/g, ''));
  return STATUS_COLORS[code] || null;
};

function budgetStatus(projected, budget) {
  if (!budget || budget <= 0) return { pct: 0, level: 'none' };
  const pct = (projected / budget) * 100;
  return { pct, level: pct > 100 ? 'over' : pct >= 80 ? 'warn' : 'ok' };
}

/** Turns any axios error into a message a person can act on. */
function friendlyError(err) {
  if (axios.isCancel(err) || (err && err.name === 'CanceledError')) return null;
  if (err && err.code === 'ECONNABORTED') {
    return 'The server took too long to respond. Try again in a moment.';
  }
  if (!err || !err.response) {
    return `Cannot reach the backend at ${API_BASE_URL}. Start it with "uvicorn main:app --reload --port 8000" and check that the address is correct.`;
  }
  const { status, data } = err.response;
  const detail = data && typeof data.detail === 'string' ? data.detail : null;
  if (status === 503) return detail || 'The database is not configured. Add your Supabase credentials to the backend .env file.';
  if (status === 400 || status === 422) return detail || 'The request was not valid. Check your filters and try again.';
  if (status === 502) return detail || 'The backend could not read from the database. Check your Supabase connection.';
  if (status >= 500) return detail || 'The server hit an error. Check the backend terminal for details.';
  return detail || `Unexpected response from the server (${status}).`;
}

function downloadCSV(filename, headers, rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* Hooks                                                               */
/* ------------------------------------------------------------------ */
/** GET helper: loading + error state, cancels stale requests automatically. */
function useApi(path, params, { refreshKey = 0, enabled = true } = {}) {
  const [state, setState] = useState({ data: null, loading: enabled, error: null });
  const [tick, setTick] = useState(0);
  const paramKey = JSON.stringify(params || {});

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .get(path, { params: JSON.parse(paramKey), signal: controller.signal })
      .then((res) => setState({ data: res.data, loading: false, error: null }))
      .catch((err) => {
        const message = friendlyError(err);
        if (message === null) return; // request was cancelled on purpose
        setState((s) => ({ ...s, loading: false, error: message }));
      });
    return () => controller.abort();
  }, [path, paramKey, refreshKey, enabled, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

function useDebounced(value, delay = 400) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

const readPage = () => {
  const id = window.location.hash.replace(/^#\/?/, '');
  return PAGES.some((p) => p.id === id) ? id : 'overview';
};

function usePage() {
  const [page, setPage] = useState(readPage);
  useEffect(() => {
    const onChange = () => {
      setPage(readPage());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return page;
}

/* ------------------------------------------------------------------ */
/* Small shared UI pieces                                              */
/* ------------------------------------------------------------------ */
function Card({ title, subtitle, icon: Icon, iconClass = 'text-blue-400', action, children, className = '' }) {
  return (
    <section className={`bg-slate-800 border border-slate-700/60 rounded-xl p-5 ${className}`}>
      {(title || action) && (
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              {Icon && <Icon className={`w-5 h-5 ${iconClass}`} aria-hidden="true" />}
              {title}
            </h2>
            {subtitle && <p className="text-xs text-slate-400 mt-1 max-w-2xl">{subtitle}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

function StatCard({ label, value, unit, icon: Icon, iconClass = 'text-blue-400', footer, loading, className = '' }) {
  return (
    <div className={`bg-slate-800 border border-slate-700/60 p-5 rounded-xl ${className}`}>
      <div className="flex items-center justify-between text-slate-400 text-sm">
        <span>{label}</span>
        {Icon && <Icon className={`w-5 h-5 ${iconClass}`} aria-hidden="true" />}
      </div>
      {loading ? (
        <div className="h-9 w-28 bg-slate-700/60 rounded mt-2 animate-pulse" />
      ) : (
        <p className="text-3xl font-bold text-white mt-2">
          {value}
          {unit && <span className="text-sm font-normal text-slate-400 ml-1">{unit}</span>}
        </p>
      )}
      {footer && <div className="mt-3 text-xs text-slate-400">{footer}</div>}
    </div>
  );
}

function PageIntro({ title, children }) {
  return (
    <div>
      <h1 className="text-xl font-bold text-white">{title}</h1>
      <p className="text-sm text-slate-400 mt-1 max-w-3xl">{children}</p>
    </div>
  );
}

function ErrorBanner({ message, onRetry }) {
  if (!message) return null;
  return (
    <div role="alert" className="bg-red-950/60 border border-red-500/40 text-red-200 rounded-xl p-4 flex items-start justify-between gap-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <p className="font-semibold text-sm">Something went wrong</p>
          <p className="text-xs text-red-300 mt-1">{message}</p>
        </div>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="shrink-0 text-xs font-medium bg-red-900/60 border border-red-700 px-3 py-1.5 rounded-lg hover:bg-red-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400"
        >
          Try again
        </button>
      )}
    </div>
  );
}

function EmptyState({ title, children }) {
  return (
    <div className="text-center py-10 px-4">
      <Info className="w-8 h-8 text-slate-500 mx-auto mb-3" aria-hidden="true" />
      <p className="text-sm font-medium text-slate-200">{title}</p>
      <p className="text-xs text-slate-400 mt-1 max-w-md mx-auto">{children}</p>
    </div>
  );
}

function Explainer({ title, children }) {
  return (
    <details className="group bg-slate-900/50 border border-slate-700/60 rounded-lg px-4 py-3 text-sm">
      <summary className="cursor-pointer text-slate-200 font-medium flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
        <Info className="w-4 h-4 text-blue-400" aria-hidden="true" /> {title}
      </summary>
      <div className="mt-3 text-xs text-slate-400 space-y-2 leading-relaxed">{children}</div>
    </details>
  );
}

function FilterSelect({ label, icon: Icon, value, onChange, options }) {
  return (
    <label className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-blue-500">
      {Icon && <Icon className="w-4 h-4 text-purple-400 shrink-0" aria-hidden="true" />}
      <span className="text-xs text-slate-400 hidden sm:inline">{label}</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-slate-200 focus:outline-none cursor-pointer"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-slate-800">
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Number input that lets you clear and retype without snapping back. */
function NumberField({ id, value, onChange, min = 0, max, step = 1, integer = false, className = '' }) {
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText((prev) => (Number(prev) === value ? prev : String(value)));
  }, [value]);

  const handleChange = (e) => {
    const raw = e.target.value;
    setText(raw);
    if (raw === '') return;
    let n = integer ? parseInt(raw, 10) : parseFloat(raw);
    if (!Number.isFinite(n)) return;
    if (n < min) n = min;
    if (max !== undefined && n > max) n = max;
    onChange(n);
  };

  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={handleChange}
      onBlur={() => setText(String(value))}
      className={`bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
    />
  );
}

function StatusBadge({ code }) {
  const n = num(code);
  const style =
    n >= 500 ? 'bg-red-500/20 text-red-300'
      : n === 429 ? 'bg-amber-500/20 text-amber-300'
        : n >= 400 ? 'bg-orange-500/20 text-orange-300'
          : 'bg-emerald-500/20 text-emerald-300';
  return <span className={`px-2 py-0.5 rounded text-xs font-mono font-medium ${style}`}>{n}</span>;
}

function ErrorRateBadge({ rate }) {
  const n = num(rate);
  const style = n > 15 ? 'bg-red-500/20 text-red-300' : n >= 5 ? 'bg-amber-500/20 text-amber-300' : 'bg-emerald-500/20 text-emerald-300';
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${style}`}>{n}%</span>;
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error) {
    console.error('Page crashed:', error);
  }
  render() {
    if (this.state.hasError) {
      return (
        <ErrorBanner
          message="This page hit an unexpected problem while drawing. Reload the page; if it keeps happening, check the browser console."
          onRetry={() => window.location.reload()}
        />
      );
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/* Page: Overview                                                      */
/* ------------------------------------------------------------------ */
function BudgetBanner({ status, projected, budget }) {
  if (status.level !== 'over' && status.level !== 'warn') return null;
  const over = status.level === 'over';
  return (
    <div
      role="alert"
      className={`rounded-xl p-4 flex items-center justify-between gap-4 border ${
        over ? 'bg-red-950/70 border-red-500/50 text-red-200' : 'bg-amber-950/60 border-amber-500/40 text-amber-200'
      }`}
    >
      <div className="flex items-center gap-3">
        <ShieldAlert className={`w-6 h-6 shrink-0 ${over ? 'text-red-400' : 'text-amber-400'}`} aria-hidden="true" />
        <div>
          <p className="font-semibold text-sm">{over ? 'Projected spend is over budget' : 'Projected spend is close to your budget'}</p>
          <p className="text-xs opacity-80">
            Forecast {fmtMoney(projected)} per month against a {fmtMoney(budget)} budget ({Math.round(status.pct)}%).
          </p>
        </div>
      </div>
      <a href="#/cost" className="shrink-0 text-xs font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-white rounded">
        Review costs
      </a>
    </div>
  );
}

function OverviewPage({ params, cost, refreshKey }) {
  const q = { ...params, cost_per_1k_tokens: cost.apiRate };
  const summary = useApi('/stats/summary', q, { refreshKey });
  const series = useApi('/stats/timeseries', params, { refreshKey });
  const endpoints = useApi('/stats/endpoints', q, { refreshKey });

  const s = summary.data;
  const loadingSummary = summary.loading && !s;
  const hasData = !!s && s.total_requests > 0;
  const budget = budgetStatus(num(s && s.projected_monthly_cost), cost.budget);
  const error = summary.error || series.error || endpoints.error;
  const retry = () => { summary.reload(); series.reload(); endpoints.reload(); };

  const latencyData = useMemo(
    () => [...(Array.isArray(endpoints.data) ? endpoints.data : [])].sort((a, b) => b.avg_latency_ms - a.avg_latency_ms),
    [endpoints.data]
  );
  const statusData = (s && s.status_distribution) || [];

  return (
    <div className="space-y-6">
      <PageIntro title="Overview">
        A live summary of how your APIs are performing. Use the filters above to focus on one service, customer tier or time range.
      </PageIntro>

      <ErrorBanner message={error} onRetry={retry} />
      {hasData && <BudgetBanner status={budget} projected={s.projected_monthly_cost} budget={cost.budget} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard label="Total requests" icon={Server} loading={loadingSummary} value={fmtInt(s && s.total_requests)} footer={s ? `${s.error_count} failed (${s.error_rate}%)` : null} />
        <StatCard
          label="Latency (P95)" icon={Clock} iconClass="text-emerald-400" loading={loadingSummary}
          value={num(s && s.p95_latency_ms)} unit="ms"
          footer={s && (
            <div className="flex flex-wrap gap-2 font-mono">
              <span className="bg-slate-900/80 px-2 py-0.5 rounded border border-slate-700">Avg <strong className="text-slate-200">{num(s.avg_latency_ms)}</strong></span>
              <span className="bg-slate-900/80 px-2 py-0.5 rounded border border-slate-700">P50 <strong className="text-emerald-400">{num(s.p50_latency_ms)}</strong></span>
              <span className="bg-slate-900/80 px-2 py-0.5 rounded border border-slate-700">P99 <strong className="text-amber-400">{num(s.p99_latency_ms)}</strong></span>
            </div>
          )}
        />
        <StatCard
          label="Rate-limited (429)" icon={AlertTriangle} iconClass="text-amber-400" loading={loadingSummary}
          value={fmtInt(s && s.rate_limit_hits)}
          footer={s && s.total_requests ? `${((s.rate_limit_hits / s.total_requests) * 100).toFixed(1)}% of requests` : null}
        />
        <StatCard
          label="Spend in this range" icon={DollarSign} iconClass="text-purple-400" loading={loadingSummary}
          value={fmtMoney(s && s.current_spend)}
          footer={s ? `${fmtInt(s.total_tokens)} tokens at ${fmtMoney(cost.apiRate)} per 1k` : null}
        />
        <StatCard
          label="Monthly forecast" icon={TrendingUp} iconClass="text-purple-400" loading={loadingSummary}
          className="border-purple-500/40 bg-gradient-to-br from-slate-800 to-purple-950/30"
          value={fmtMoney(s && s.projected_monthly_cost)}
          footer={cost.budget > 0 ? `${Math.round(budget.pct)}% of your ${fmtMoney(cost.budget)} budget` : 'Set a budget on the Cost page'}
        />
      </div>

      {!loadingSummary && !error && !hasData ? (
        <Card>
          <EmptyState title="No requests match these filters">
            Try a longer time range or a different service. If the database is empty, run "python seed.py" in the backend folder to add sample data.
          </EmptyState>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <Card
              className="lg:col-span-2" title="Traffic over time" icon={TrendingUp}
              subtitle={params.days <= 2 ? 'Requests per hour. Red shows how many of them failed.' : 'Requests per day. Red shows how many of them failed.'}
            >
              {Array.isArray(series.data) && series.data.length > 0 ? (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={series.data} margin={{ left: 0, right: 10, top: 5 }}>
                    <defs>
                      <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.5} />
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gErr" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#ef4444" stopOpacity={0.6} />
                        <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                    <XAxis dataKey="label" stroke="#94a3b8" tick={{ fontSize: 11 }} minTickGap={28} />
                    <YAxis stroke="#94a3b8" tick={{ fontSize: 11 }} allowDecimals={false} />
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Legend />
                    <Area type="monotone" dataKey="requests" name="Requests" stroke="#3b82f6" fill="url(#gReq)" strokeWidth={2} />
                    <Area type="monotone" dataKey="errors" name="Failed" stroke="#ef4444" fill="url(#gErr)" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[260px] bg-slate-900/40 rounded-lg animate-pulse" />
              )}
            </Card>

            <Card title="HTTP status codes" icon={PieIcon} iconClass="text-emerald-400" subtitle="200 means success, 429 means rate-limited, 500 means a server error.">
              {statusData.length > 0 ? (
                <ResponsiveContainer width="100%" height={260}>
                  <PieChart>
                    <Pie data={statusData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4} dataKey="value" nameKey="name">
                      {statusData.map((entry, i) => (
                        <Cell key={entry.name} fill={statusColor(entry.name) || FALLBACK_COLORS[i % FALLBACK_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip {...TOOLTIP_STYLE} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-[260px] bg-slate-900/40 rounded-lg animate-pulse" />
              )}
            </Card>
          </div>

          <Card title="Average latency by endpoint" icon={Clock} iconClass="text-emerald-400" subtitle="Longer bars are slower. Image generation is usually the slowest.">
            {latencyData.length > 0 ? (
              <ResponsiveContainer width="100%" height={Math.max(200, latencyData.length * 46)}>
                <BarChart data={latencyData} layout="vertical" margin={{ left: 10, right: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                  <XAxis type="number" stroke="#94a3b8" tick={{ fontSize: 11 }} unit=" ms" />
                  <YAxis type="category" dataKey="endpoint" width={170} stroke="#94a3b8" tick={{ fontSize: 11 }} />
                  <Tooltip {...TOOLTIP_STYLE} cursor={{ fill: '#33415540' }} />
                  <Bar dataKey="avg_latency_ms" name="Avg latency (ms)" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-[200px] bg-slate-900/40 rounded-lg animate-pulse" />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page: Endpoints                                                     */
/* ------------------------------------------------------------------ */
const ENDPOINT_COLUMNS = [
  { key: 'endpoint', label: 'Endpoint' },
  { key: 'total_calls', label: 'Calls' },
  { key: 'avg_latency_ms', label: 'Avg latency' },
  { key: 'p95_latency_ms', label: 'P95 latency' },
  { key: 'error_rate', label: 'Error rate' },
  { key: 'tokens_used', label: 'Tokens' },
  { key: 'estimated_cost', label: 'Est. cost' },
];

function EndpointsPage({ params, cost, refreshKey }) {
  const { data, loading, error, reload } = useApi('/stats/endpoints', { ...params, cost_per_1k_tokens: cost.apiRate }, { refreshKey });
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState({ key: 'total_calls', dir: 'desc' });

  const rows = useMemo(() => {
    const list = Array.isArray(data) ? data : [];
    const filtered = list.filter((r) => r.endpoint.toLowerCase().includes(query.trim().toLowerCase()));
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) =>
      sort.key === 'endpoint' ? dir * a.endpoint.localeCompare(b.endpoint) : dir * (num(a[sort.key]) - num(b[sort.key]))
    );
  }, [data, query, sort]);

  const toggleSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'endpoint' ? 'asc' : 'desc' }));

  const exportRows = () =>
    downloadCSV(
      `endpoint_stats_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Endpoint', 'Calls', 'Avg latency (ms)', 'P95 latency (ms)', 'Errors', 'Error rate (%)', 'Tokens', 'Estimated cost ($)'],
      rows.map((r) => [r.endpoint, r.total_calls, r.avg_latency_ms, r.p95_latency_ms, r.error_count, r.error_rate, r.tokens_used, r.estimated_cost])
    );

  const maxCalls = Math.max(1, ...rows.map((r) => num(r.total_calls)));

  return (
    <div className="space-y-6">
      <PageIntro title="Endpoints">
        Compare every endpoint side by side. Click a column heading to sort, type to search, and export what you see as a CSV file.
      </PageIntro>
      <ErrorBanner message={error} onRetry={reload} />

      <Card
        title="Endpoint performance" icon={Server}
        subtitle="Error rate is green below 5%, amber from 5% to 15%, and red above 15%."
        action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus-within:ring-2 focus-within:ring-blue-500">
              <Search className="w-4 h-4 text-slate-400" aria-hidden="true" />
              <input
                aria-label="Search endpoints" placeholder="Search endpoints" value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="bg-transparent text-slate-200 placeholder-slate-500 focus:outline-none w-40"
              />
            </label>
            <button
              onClick={exportRows} disabled={rows.length === 0}
              className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700 text-slate-200 text-sm px-3 py-1.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            >
              <Download className="w-4 h-4 text-slate-400" aria-hidden="true" /> Export CSV
            </button>
          </div>
        }
      >
        {loading && !data ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-10 bg-slate-900/50 rounded animate-pulse" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState title={query ? 'No endpoints match your search' : 'No endpoint data yet'}>
            {query ? 'Clear the search box or check the spelling.' : 'Try a longer time range, or run "python seed.py" to add sample data.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="text-xs text-slate-400 bg-slate-900/60">
                <tr>
                  {ENDPOINT_COLUMNS.map((c) => (
                    <th key={c.key} scope="col" className="py-3 px-4 font-medium" aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                      <button onClick={() => toggleSort(c.key)} className="flex items-center gap-1 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
                        {c.label}
                        <span aria-hidden="true" className="text-blue-400">{sort.key === c.key ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {rows.map((r) => (
                  <tr key={r.endpoint} className="hover:bg-slate-700/30">
                    <td className="py-3 px-4 font-mono text-xs text-blue-400">{r.endpoint}</td>
                    <td className="py-3 px-4 min-w-[120px]">
                      <div>{fmtInt(r.total_calls)}</div>
                      <div className="h-1 bg-slate-700 rounded mt-1" aria-hidden="true">
                        <div className="h-1 bg-blue-500 rounded" style={{ width: `${(num(r.total_calls) / maxCalls) * 100}%` }} />
                      </div>
                    </td>
                    <td className="py-3 px-4">{num(r.avg_latency_ms)} ms</td>
                    <td className="py-3 px-4">{num(r.p95_latency_ms)} ms</td>
                    <td className="py-3 px-4"><ErrorRateBadge rate={r.error_rate} /></td>
                    <td className="py-3 px-4">{fmtInt(r.tokens_used)}</td>
                    <td className="py-3 px-4">{fmtMoney(r.estimated_cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page: Request logs                                                  */
/* ------------------------------------------------------------------ */
function LogsPage({ params, refreshKey }) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [endpoint, setEndpoint] = useState('all');
  const [limit, setLimit] = useState(25);
  const debouncedSearch = useDebounced(search, 350);

  const endpointList = useApi('/stats/endpoints', params, { refreshKey });

  // Page number resets automatically whenever any filter changes.
  const filterSig = JSON.stringify([params, debouncedSearch, status, endpoint, limit]);
  const [pageState, setPageState] = useState({ sig: filterSig, page: 0 });
  const page = pageState.sig === filterSig ? pageState.page : 0;
  const setPage = (p) => setPageState({ sig: filterSig, page: p });

  const logs = useApi(
    '/logs',
    {
      ...params,
      search: debouncedSearch.trim() || undefined,
      status_code: status === 'all' ? undefined : status,
      endpoint: endpoint === 'all' ? undefined : endpoint,
      limit,
      offset: page * limit,
    },
    { refreshKey }
  );

  const items = logs.data && Array.isArray(logs.data.items) ? logs.data.items : [];
  const total = logs.data ? num(logs.data.total) : 0;
  const pageCount = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : page * limit + 1;
  const to = page * limit + items.length;
  const filtersActive = search || status !== 'all' || endpoint !== 'all';

  const clearFilters = () => { setSearch(''); setStatus('all'); setEndpoint('all'); };

  const endpointOptions = [
    { value: 'all', label: 'All endpoints' },
    ...(Array.isArray(endpointList.data) ? endpointList.data : []).map((e) => ({ value: e.endpoint, label: e.endpoint })),
  ];

  const exportPage = () =>
    downloadCSV(
      `request_logs_${new Date().toISOString().slice(0, 10)}.csv`,
      ['Time', 'Service', 'Method', 'Endpoint', 'Status', 'Latency (ms)', 'Tier', 'Tokens'],
      items.map((l) => [fmtDate(l.timestamp), l.service_name, l.method, l.endpoint, l.status_code, l.latency_ms, l.user_tier, l.tokens_used])
    );

  return (
    <div className="space-y-6">
      <PageIntro title="Request logs">
        Look up individual requests. Search by endpoint path, narrow by status code, and page through results. The service, tier and time filters at the top also apply here.
      </PageIntro>
      <ErrorBanner message={logs.error} onRetry={logs.reload} />

      <Card
        title="Recent requests" icon={List}
        action={
          <button
            onClick={exportPage} disabled={items.length === 0}
            className="flex items-center gap-1.5 bg-slate-900 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed border border-slate-700 text-slate-200 text-sm px-3 py-1.5 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <Download className="w-4 h-4 text-slate-400" aria-hidden="true" /> Export this page
          </button>
        }
      >
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <label className="flex items-center gap-2 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-blue-500">
            <Search className="w-4 h-4 text-slate-400" aria-hidden="true" />
            <input
              aria-label="Search by endpoint path" placeholder="Search endpoint path" value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent text-slate-200 placeholder-slate-500 focus:outline-none w-48"
            />
          </label>
          <FilterSelect
            label="Status" value={status} onChange={setStatus}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: '200', label: '200 Success' },
              { value: '429', label: '429 Rate-limited' },
              { value: '500', label: '500 Server error' },
            ]}
          />
          <FilterSelect label="Endpoint" value={endpoint} onChange={setEndpoint} options={endpointOptions} />
          <FilterSelect
            label="Rows" value={limit} onChange={(v) => setLimit(Number(v))}
            options={[10, 25, 50, 100].map((n) => ({ value: n, label: `${n} per page` }))}
          />
          {filtersActive && (
            <button onClick={clearFilters} className="text-xs text-blue-400 hover:text-blue-300 underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded">
              Clear filters
            </button>
          )}
        </div>

        {logs.loading && !logs.data ? (
          <div className="space-y-2" aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-9 bg-slate-900/50 rounded animate-pulse" />)}
          </div>
        ) : items.length === 0 ? (
          <EmptyState title="No requests found">
            {filtersActive ? 'No logs match your search and filters. Clear them or widen the time range.' : 'There are no logs in this time range. Run "python seed.py" to add sample data.'}
          </EmptyState>
        ) : (
          <div className={`overflow-x-auto ${logs.loading ? 'opacity-60' : ''}`}>
            <table className="w-full text-left text-sm text-slate-300">
              <thead className="text-xs text-slate-400 bg-slate-900/60">
                <tr>
                  {['Time', 'Service', 'Endpoint', 'Status', 'Latency', 'Tier', 'Tokens'].map((h) => (
                    <th key={h} scope="col" className="py-3 px-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/50">
                {items.map((l, i) => (
                  <tr key={l.id ?? `${l.timestamp}-${i}`} className="hover:bg-slate-700/30">
                    <td className="py-2.5 px-4 text-xs whitespace-nowrap">{fmtDate(l.timestamp)}</td>
                    <td className="py-2.5 px-4 text-xs">{l.service_name}</td>
                    <td className="py-2.5 px-4 font-mono text-xs text-blue-400 whitespace-nowrap">
                      <span className="text-slate-500 mr-2">{l.method}</span>{l.endpoint}
                    </td>
                    <td className="py-2.5 px-4"><StatusBadge code={l.status_code} /></td>
                    <td className={`py-2.5 px-4 text-xs ${num(l.latency_ms) > 1000 ? 'text-amber-300' : ''}`}>{num(l.latency_ms)} ms</td>
                    <td className="py-2.5 px-4 text-xs capitalize">{l.user_tier}</td>
                    <td className="py-2.5 px-4 text-xs">{fmtInt(l.tokens_used)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 mt-4 text-xs text-slate-400">
            <span>Showing {fmtInt(from)} to {fmtInt(to)} of {fmtInt(total)} requests</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}
                aria-label="Previous page"
                className="p-1.5 rounded-lg border border-slate-700 bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              </button>
              <span>Page {page + 1} of {pageCount}</span>
              <button
                onClick={() => setPage(Math.min(pageCount - 1, page + 1))} disabled={page >= pageCount - 1}
                aria-label="Next page"
                className="p-1.5 rounded-lg border border-slate-700 bg-slate-900 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <ChevronRight className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page: Cost and insights                                             */
/* ------------------------------------------------------------------ */
const REC_STYLES = {
  error: 'bg-red-950/30 border-red-500/40',
  warning: 'bg-amber-950/30 border-amber-500/40',
  info: 'bg-blue-950/30 border-blue-500/40',
  success: 'bg-emerald-950/30 border-emerald-500/40',
};

function CostPage({ params, cost, refreshKey }) {
  const [cacheRatio, setCacheRatio] = useState(0.3);
  const debouncedRatio = useDebounced(cacheRatio, 250);

  const summary = useApi('/stats/summary', { ...params, cost_per_1k_tokens: cost.apiRate }, { refreshKey });
  const sim = useApi('/simulate/cache-and-limits', { ...params, cache_hit_ratio: debouncedRatio, cost_per_1k_tokens: cost.apiRate }, { refreshKey });
  const recs = useApi('/recommendations', params, { refreshKey });

  const s = summary.data;
  const projected = num(s && s.projected_monthly_cost);
  const status = budgetStatus(projected, cost.budget);
  const barColor = status.level === 'over' ? 'bg-red-500' : status.level === 'warn' ? 'bg-amber-500' : 'bg-emerald-500';
  const days = (s && s.days) || params.days;
  const simData = sim.data && sim.data.has_data ? sim.data : null;
  const error = summary.error || sim.error || recs.error;
  const retry = () => { summary.reload(); sim.reload(); recs.reload(); };

  return (
    <div className="space-y-6">
      <PageIntro title="Cost and insights">
        See what your traffic costs, where the month is heading, and how much caching could save. Spend is calculated from tokens used, so changing the rate updates every page.
      </PageIntro>
      <ErrorBanner message={error} onRetry={retry} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title="Spend and forecast" icon={DollarSign} iconClass="text-purple-400" subtitle={`Based on the last ${days} ${days === 1 ? 'day' : 'days'} of traffic with the filters you chose.`}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-4">
              <p className="text-xs text-slate-400">Spend in this range</p>
              {summary.loading && !s ? <div className="h-8 w-20 bg-slate-700/60 rounded mt-2 animate-pulse" /> : <p className="text-2xl font-bold text-white mt-1">{fmtMoney(s && s.current_spend)}</p>}
              <p className="text-[11px] text-slate-500 mt-1">{fmtInt(s && s.total_tokens)} tokens</p>
            </div>
            <div className="bg-slate-900/60 border border-purple-500/30 rounded-lg p-4">
              <p className="text-xs text-slate-400">Monthly forecast</p>
              {summary.loading && !s ? <div className="h-8 w-20 bg-slate-700/60 rounded mt-2 animate-pulse" /> : <p className="text-2xl font-bold text-purple-300 mt-1">{fmtMoney(projected)}</p>}
              <p className="text-[11px] text-slate-500 mt-1">30-day run rate</p>
            </div>
            <div className="bg-slate-900/60 border border-slate-700/50 rounded-lg p-4">
              <p className="text-xs text-slate-400">Left in budget</p>
              <p className={`text-2xl font-bold mt-1 ${status.level === 'over' ? 'text-red-400' : 'text-emerald-400'}`}>
                {cost.budget > 0 ? fmtMoney(cost.budget - projected) : '—'}
              </p>
              <p className="text-[11px] text-slate-500 mt-1">{cost.budget > 0 ? `Budget ${fmtMoney(cost.budget)} per month` : 'No budget set'}</p>
            </div>
          </div>

          {cost.budget > 0 && (
            <div className="mt-5">
              <div className="flex justify-between text-xs text-slate-400 mb-1">
                <span>Forecast vs budget</span>
                <span className={status.level === 'over' ? 'text-red-400 font-semibold' : ''}>{Math.round(status.pct)}%</span>
              </div>
              <div className="h-2.5 bg-slate-700 rounded-full overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.round(status.pct))} aria-label="Forecast as a percentage of budget">
                <div className={`h-full ${barColor} rounded-full`} style={{ width: `${Math.min(100, status.pct)}%` }} />
              </div>
              <p className="text-xs mt-2 text-slate-400">
                {status.level === 'over' && 'You are on track to go over budget. Try caching or a cheaper model for simple requests.'}
                {status.level === 'warn' && 'You are close to your budget. Keep an eye on token-heavy endpoints.'}
                {status.level === 'ok' && 'You are within budget at the current pace.'}
              </p>
            </div>
          )}
        </Card>

        <Card title="Cost settings" icon={Sliders} iconClass="text-purple-400" subtitle="These two values are used across the whole dashboard.">
          <div className="space-y-4">
            <div>
              <label htmlFor="rate" className="text-xs text-slate-300 block mb-1">Price per 1,000 tokens ($)</label>
              <NumberField id="rate" value={cost.rate} onChange={cost.setRate} min={0} step={0.0005} className="w-full" />
            </div>
            <div>
              <label htmlFor="budget" className="text-xs text-slate-300 block mb-1">Monthly budget ($)</label>
              <NumberField id="budget" value={cost.budget} onChange={cost.setBudget} min={0} step={1} className="w-full" />
              <p className="text-[11px] text-slate-500 mt-1">Set to 0 to turn budget alerts off.</p>
            </div>
          </div>
        </Card>
      </div>

      <Explainer title="How is the monthly forecast calculated?">
        <p>Spend in the selected range = tokens used ÷ 1,000 × price per 1,000 tokens.</p>
        <p>Monthly forecast = spend in the range ÷ number of days in the range × 30.</p>
        <p>Every page uses this same formula, so the numbers always match. A longer range such as 30 days smooths out busy and quiet days.</p>
      </Explainer>

      <Card
        title="Response caching simulator" icon={TrendingUp} iconClass="text-emerald-400"
        subtitle="Estimate what happens if a share of requests were answered from a cache instead of the model."
        action={
          <div className="flex items-center gap-3 bg-slate-900/80 px-4 py-2 rounded-lg border border-slate-700/80">
            <label htmlFor="cache" className="text-xs text-slate-300 font-medium">
              Cache hit rate: <span className="text-emerald-400 font-bold">{Math.round(cacheRatio * 100)}%</span>
            </label>
            <input id="cache" type="range" min="0" max="0.9" step="0.05" value={cacheRatio} onChange={(e) => setCacheRatio(parseFloat(e.target.value))} className="w-32 accent-emerald-500 cursor-pointer" />
          </div>
        }
      >
        {sim.loading && !sim.data ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 bg-slate-900/50 rounded-lg animate-pulse" />)}
          </div>
        ) : simData ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-700/50">
              <span className="text-xs text-slate-400 block mb-1">Average latency</span>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-emerald-400">{simData.simulated_avg_latency_ms} ms</span>
                <span className="text-xs text-slate-500 line-through">{simData.original_avg_latency_ms} ms</span>
              </div>
              <p className="text-[11px] text-emerald-400/90 mt-1">{simData.latency_reduction_pct}% faster overall</p>
            </div>
            <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-700/50">
              <span className="text-xs text-slate-400 block mb-1">Spend in this range</span>
              <div className="flex items-baseline gap-2">
                <span className="text-2xl font-bold text-purple-400">{fmtMoney(simData.simulated_cost)}</span>
                <span className="text-xs text-slate-500 line-through">{fmtMoney(simData.original_cost)}</span>
              </div>
              <p className="text-[11px] text-purple-300 mt-1">Saves {fmtMoney(simData.cost_savings)}</p>
            </div>
            <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-700/50">
              <span className="text-xs text-slate-400 block mb-1">Saved per month</span>
              <span className="text-2xl font-bold text-white">{fmtMoney(simData.projected_monthly_savings)}</span>
              <p className="text-[11px] text-slate-400 mt-1">{fmtInt(simData.tokens_saved)} tokens not sent to the model</p>
            </div>
            <div className="bg-slate-900/60 p-4 rounded-lg border border-slate-700/50">
              <span className="text-xs text-slate-400 block mb-1">Requests served from cache</span>
              <span className="text-2xl font-bold text-blue-400">{fmtInt(simData.cached_requests)}</span>
              <p className="text-[11px] text-slate-400 mt-1">out of {fmtInt(simData.total_requests)} requests</p>
            </div>
          </div>
        ) : (
          !sim.error && <EmptyState title="Nothing to simulate yet">There is no traffic in this range. Choose a longer range or run "python seed.py".</EmptyState>
        )}
        <p className="text-[11px] text-slate-500 mt-4">Cached responses are assumed to return in about 15 ms and use no tokens.</p>
      </Card>

      <Card title="Recommendations" icon={Sparkles} iconClass="text-purple-400" subtitle="Suggestions generated from your traffic. They change with the filters above.">
        {recs.loading && !recs.data ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[0, 1].map((i) => <div key={i} className="h-24 bg-slate-900/50 rounded-lg animate-pulse" />)}
          </div>
        ) : Array.isArray(recs.data) && recs.data.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {recs.data.map((rec) => (
              <div key={rec.id} className={`p-4 rounded-lg border ${REC_STYLES[rec.type] || REC_STYLES.info}`}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <h3 className="text-sm font-semibold text-white">{rec.title}</h3>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-slate-900/80 text-slate-300 border border-slate-700 shrink-0">{rec.impact}</span>
                </div>
                <p className="text-xs text-slate-300 mt-2 leading-relaxed">{rec.description}</p>
              </div>
            ))}
          </div>
        ) : (
          !recs.error && <EmptyState title="No recommendations yet">Recommendations appear once there is traffic in the selected range.</EmptyState>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page: Rate limits                                                   */
/* ------------------------------------------------------------------ */
function RateLimitsPage({ refreshKey }) {
  const tiers = useApi('/tier-limits', {}, { refreshKey });
  const [tier, setTier] = useState('free');
  const [count, setCount] = useState(15);
  const [run, setRun] = useState({ loading: false, error: null, result: null });

  const limits = Array.isArray(tiers.data) ? tiers.data : [];
  const current = limits.find((t) => t.tier === tier);
  const limit = current ? current.limit : null;
  const sliderMax = limit ? limit * 2 : 100;

  const simulate = useCallback(async (t, c) => {
    setRun((r) => ({ ...r, loading: true, error: null }));
    try {
      const res = await api.get('/simulate/rate-limit', {
        params: { tier: t, simulated_request_count: c },
        // 429 is an expected answer here, not a failure.
        validateStatus: (code) => code === 200 || code === 429,
      });
      const h = res.headers || {};
      setRun({
        loading: false,
        error: null,
        result: {
          status: res.status,
          data: res.data || {},
          limitHeader: h['x-ratelimit-limit'],
          remainingHeader: h['x-ratelimit-remaining'],
          retryAfter: h['retry-after'],
        },
      });
    } catch (err) {
      setRun({ loading: false, error: friendlyError(err) || 'The simulation could not be completed.', result: null });
    }
  }, []);

  const pickTier = (t) => {
    const l = limits.find((x) => x.tier === t);
    setTier(t);
    if (l) setCount(Math.max(1, Math.ceil(l.limit * 0.5)));
    setRun({ loading: false, error: null, result: null });
  };

  const preset = (c) => { setCount(c); simulate(tier, c); };

  const r = run.result;
  const blocked = r && r.status === 429;
  const usagePct = r ? Math.min(100, num(r.data.usage_pct)) : 0;

  return (
    <div className="space-y-6">
      <PageIntro title="Rate limits">
        Each customer tier can send a fixed number of requests per minute. Try a tier and a number of requests to see how the API gateway responds.
      </PageIntro>
      <ErrorBanner message={tiers.error} onRetry={tiers.reload} />

      <Card title="Try a scenario" icon={Sliders} subtitle="Choose a tier, set how many requests are sent in one minute, then run the simulation.">
        <fieldset>
          <legend className="text-xs text-slate-300 mb-2">1. Customer tier</legend>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {limits.map((t) => (
              <label
                key={t.tier}
                className={`cursor-pointer rounded-lg border p-4 focus-within:ring-2 focus-within:ring-blue-500 ${tier === t.tier ? 'border-blue-500 bg-blue-950/30' : 'border-slate-700 bg-slate-900/50 hover:border-slate-500'}`}
              >
                <input type="radio" name="tier" value={t.tier} checked={tier === t.tier} onChange={() => pickTier(t.tier)} className="sr-only" />
                <span className="block text-sm font-semibold text-white capitalize">{t.tier}</span>
                <span className="block text-xs text-slate-400 mt-1">{fmtInt(t.limit)} requests per {t.window_sec} seconds</span>
              </label>
            ))}
            {tiers.loading && !tiers.data && [0, 1, 2].map((i) => <div key={i} className="h-16 bg-slate-900/50 rounded-lg animate-pulse" />)}
          </div>
        </fieldset>

        <div className="mt-6">
          <label htmlFor="count" className="text-xs text-slate-300 block mb-2">2. Requests sent in one minute</label>
          <div className="flex flex-wrap items-center gap-4">
            <input
              type="range" min="0" max={sliderMax} step="1" value={Math.min(count, sliderMax)}
              onChange={(e) => setCount(parseInt(e.target.value, 10))}
              aria-label="Requests sent in one minute"
              className="w-56 accent-blue-500 cursor-pointer"
            />
            <NumberField id="count" value={count} onChange={setCount} min={0} max={1000000} integer className="w-24 text-center" />
            <div className="flex gap-2 text-xs">
              {limit && [
                { label: 'Under the limit', value: Math.max(0, Math.floor(limit * 0.5)) },
                { label: 'At the limit', value: limit },
                { label: 'Over the limit', value: limit + Math.max(1, Math.ceil(limit * 0.3)) },
              ].map((p) => (
                <button
                  key={p.label} onClick={() => preset(p.value)}
                  className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-700 text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  {p.label} ({p.value})
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-6">
          <button
            onClick={() => simulate(tier, count)} disabled={run.loading || !limit}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm px-5 py-2 rounded-lg font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
          >
            <Zap className="w-4 h-4" aria-hidden="true" /> {run.loading ? 'Running...' : 'Run simulation'}
          </button>
        </div>
      </Card>

      <ErrorBanner message={run.error} onRetry={() => simulate(tier, count)} />

      <Card title="Gateway response" icon={Zap} iconClass="text-amber-400">
        {!r ? (
          <EmptyState title="No simulation yet">Pick a tier and a number of requests, then press "Run simulation".</EmptyState>
        ) : (
          <div role="status" className={`p-4 rounded-lg border ${blocked ? 'bg-red-950/30 border-red-500/40' : 'bg-emerald-950/30 border-emerald-500/40'}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className={`text-lg font-bold ${blocked ? 'text-red-300' : 'text-emerald-300'}`}>
                {r.status} {blocked ? 'Too many requests' : 'Accepted'}
              </p>
              <p className="text-xs text-slate-300">
                {fmtInt(r.data.requested_count)} of {fmtInt(r.data.tier_limit)} allowed ({num(r.data.usage_pct)}%)
              </p>
            </div>
            <div className="h-2.5 bg-slate-700 rounded-full overflow-hidden mt-3" aria-hidden="true">
              <div className={`h-full rounded-full ${blocked ? 'bg-red-500' : usagePct >= 80 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${usagePct}%` }} />
            </div>
            <p className="text-sm text-slate-200 mt-3">{r.data.message}</p>

            <dl className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
              <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/60">
                <dt className="text-slate-400">X-RateLimit-Limit</dt>
                <dd className="text-white mt-1">{r.limitHeader ?? r.data.tier_limit}</dd>
              </div>
              <div className="bg-slate-900/60 rounded-lg p-3 border border-slate-700/60">
                <dt className="text-slate-400">X-RateLimit-Remaining</dt>
                <dd className="text-white mt-1">{r.remainingHeader ?? r.data.remaining_quota}</dd>
              </div>
              {blocked && (
                <div className="bg-red-950/40 rounded-lg p-3 border border-red-500/30">
                  <dt className="text-red-300">Retry-After</dt>
                  <dd className="text-red-200 mt-1">{r.retryAfter ?? r.data.retry_after_sec} seconds</dd>
                </div>
              )}
            </dl>
            {blocked && <p className="text-xs text-slate-400 mt-3">Clients should wait for the Retry-After time before sending again, and increase the wait after each repeated 429 (exponential backoff).</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App shell                                                           */
/* ------------------------------------------------------------------ */
function ConnectionBadge({ health }) {
  let label = 'Connecting';
  let style = 'bg-slate-700/50 text-slate-300 border-slate-600';
  if (health.error) {
    label = 'API offline';
    style = 'bg-red-500/15 text-red-300 border-red-500/40';
  } else if (health.data && !health.data.database_configured) {
    label = 'Database not set up';
    style = 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  } else if (health.data) {
    label = 'API online';
    style = 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  }
  return <span className={`text-xs px-2.5 py-1 rounded-full border ${style}`} role="status">{label}</span>;
}

export default function App() {
  const page = usePage();
  const [filters, setFilters] = useState({ service: 'All Services', tier: 'all', days: 7 });
  const [refreshKey, setRefreshKey] = useState(0);
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());

  // Cost settings live here so every page calculates spend the same way.
  const [rate, setRate] = useState(0.002);
  const [budget, setBudget] = useState(10);
  const apiRate = useDebounced(rate, 400);
  const cost = useMemo(() => ({ rate, setRate, budget, setBudget, apiRate }), [rate, budget, apiRate]);

  const health = useApi('/health', {}, { refreshKey });
  const services = useApi('/services', {}, { refreshKey });

  const serviceOptions = (Array.isArray(services.data) && services.data.length > 0 ? services.data : ['All Services']).map((s) => ({ value: s, label: s }));
  const params = useMemo(() => ({ service: filters.service, tier: filters.tier, days: filters.days }), [filters]);
  const setFilter = (key) => (value) => setFilters((f) => ({ ...f, [key]: key === 'days' ? Number(value) : value }));

  const refresh = () => { setRefreshKey((k) => k + 1); setLastRefreshed(new Date()); };
  const showFilters = page !== 'limits';
  const dbMissing = health.data && !health.data.database_configured;

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 font-sans">
      <header className="border-b border-slate-800 bg-slate-900/95 sticky top-0 z-20 backdrop-blur">
        <div className="max-w-7xl mx-auto px-6 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xl font-bold text-white flex items-center gap-2">
                <Activity className="text-blue-500" aria-hidden="true" /> Micro-SaaS API Command Center
              </p>
              <p className="text-slate-400 text-xs mt-0.5">Latency, errors, rate limits and cost for your API services</p>
            </div>
            <div className="flex items-center gap-3">
              <ConnectionBadge health={health} />
              <button
                onClick={refresh}
                className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 text-white text-sm px-4 py-2 rounded-lg font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
              >
                <RefreshCw className="w-4 h-4" aria-hidden="true" /> Refresh
              </button>
            </div>
          </div>

          <nav aria-label="Main" className="flex gap-1 mt-4 overflow-x-auto">
            {PAGES.map(({ id, label, icon: Icon }) => (
              <a
                key={id} href={`#/${id}`} aria-current={page === id ? 'page' : undefined}
                className={`flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap border-b-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded-t-lg ${
                  page === id ? 'border-blue-500 text-white font-medium' : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" aria-hidden="true" /> {label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6 space-y-6">
        {health.error && <ErrorBanner message={health.error} onRetry={health.reload} />}
        {dbMissing && (
          <div role="alert" className="bg-amber-950/50 border border-amber-500/40 text-amber-200 rounded-xl p-4 text-sm">
            <p className="font-semibold">The database is not connected</p>
            <p className="text-xs text-amber-300 mt-1">{health.data.detail}</p>
          </div>
        )}

        {showFilters && (
          <div className="flex flex-wrap items-center gap-3">
            <FilterSelect label="Service" icon={Layers} value={filters.service} onChange={setFilter('service')} options={serviceOptions} />
            <FilterSelect label="Tier" icon={Users} value={filters.tier} onChange={setFilter('tier')} options={TIER_OPTIONS} />
            <FilterSelect label="Time range" icon={Calendar} value={filters.days} onChange={setFilter('days')} options={RANGE_OPTIONS} />
            <span className="text-xs text-slate-500 ml-auto">Filters apply to every page. Updated {lastRefreshed.toLocaleTimeString()}</span>
          </div>
        )}

        <ErrorBoundary key={page}>
          {page === 'overview' && <OverviewPage params={params} cost={cost} refreshKey={refreshKey} />}
          {page === 'endpoints' && <EndpointsPage params={params} cost={cost} refreshKey={refreshKey} />}
          {page === 'logs' && <LogsPage params={params} refreshKey={refreshKey} />}
          {page === 'cost' && <CostPage params={params} cost={cost} refreshKey={refreshKey} />}
          {page === 'limits' && <RateLimitsPage refreshKey={refreshKey} />}
        </ErrorBoundary>
      </main>
    </div>
  );
}
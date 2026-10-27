"""
Micro-SaaS API Analytics Engine  (FastAPI + Supabase)

Run:
    pip install fastapi "uvicorn[standard]" supabase python-dotenv numpy
    uvicorn main:app --reload --port 8000

Environment (.env):
    SUPABASE_URL=...
    SUPABASE_KEY=...
    CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173   (optional)

Expected table `api_logs` columns:
    service_name, endpoint, method, status_code, latency_ms,
    user_tier, tokens_used, timestamp (timestamptz, default now())
"""

import logging
import os
import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import numpy as np
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from supabase import Client, create_client

load_dotenv()

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("api-analytics")

# ---------------------------------------------------------------------------
# Safe Supabase initialisation: the server still starts if credentials are
# missing, and every data endpoint answers with a clear 503 message instead
# of crashing at import time.
# ---------------------------------------------------------------------------
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

supabase: Optional[Client] = None
db_init_error: Optional[str] = None

if not SUPABASE_URL or not SUPABASE_KEY:
    db_init_error = (
        "SUPABASE_URL or SUPABASE_KEY is missing. Add both to the .env file "
        "in the backend folder, then restart the server."
    )
else:
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception as exc:  # noqa: BLE001
        db_init_error = (
            f"Could not create the Supabase client ({type(exc).__name__}). "
            "Check that SUPABASE_URL and SUPABASE_KEY are correct."
        )
        logger.error(db_init_error)


def get_db() -> Client:
    if supabase is None:
        raise HTTPException(status_code=503, detail=db_init_error or "Database is not configured.")
    return supabase


# ---------------------------------------------------------------------------
# App + CORS
# ---------------------------------------------------------------------------
app = FastAPI(title="Micro-SaaS API Command Center")

# Enable CORS for Vercel deployment
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows Vercel frontend to connect
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    # Lets the browser read these headers in the rate-limit simulator.
    expose_headers=["Retry-After", "X-RateLimit-Limit", "X-RateLimit-Remaining"],
)

# ---------------------------------------------------------------------------
# Shared configuration (single source of truth, also served to the frontend)
# ---------------------------------------------------------------------------
SERVICES = ["All Services", "LLM Inference API", "Payment Gateway", "Auth Service"]

TIER_LIMITS = {
    "free": {"limit": 10, "window_sec": 60},
    "pro": {"limit": 100, "window_sec": 60},
    "enterprise": {"limit": 1000, "window_sec": 60},
}

DEFAULT_COST_PER_1K = 0.002
PAGE_SIZE = 1000          # Supabase returns at most 1000 rows per request
MAX_ROWS = 50000          # safety cap for a single analytics query
CACHED_RESPONSE_LATENCY_MS = 15


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def num(value: Any, default: float = 0) -> float:
    """Convert DB values to numbers safely (None / bad data become default)."""
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def is_specific(value: Optional[str]) -> bool:
    return bool(value) and value.strip().lower() not in ("all", "all services")


def normalize_tier(tier: Optional[str]) -> Optional[str]:
    if not is_specific(tier):
        return None
    key = tier.strip().lower()
    if key not in TIER_LIMITS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown tier '{tier}'. Use one of: {', '.join(TIER_LIMITS)}.",
        )
    return key


def since_iso(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(value: Any) -> Optional[datetime]:
    """Parse Supabase timestamps on any Python 3.8+ version."""
    if not value:
        return None
    try:
        text = str(value).replace("Z", "+00:00")
        match = re.match(r"^(.*?\.)(\d+)(.*)$", text)
        if match:
            text = match.group(1) + match.group(2)[:6].ljust(6, "0") + match.group(3)
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def apply_filters(
    query,
    *,
    tier: Optional[str] = None,
    service: Optional[str] = None,
    days: Optional[int] = None,
    endpoint: Optional[str] = None,
    status_code: Optional[int] = None,
    search: Optional[str] = None,
):
    """Apply the same filters everywhere so every page agrees with each other."""
    tier_key = normalize_tier(tier)
    if tier_key:
        query = query.eq("user_tier", tier_key)
    if is_specific(service):
        query = query.eq("service_name", service.strip())
    if days:
        query = query.gte("timestamp", since_iso(days))
    if is_specific(endpoint):
        query = query.eq("endpoint", endpoint.strip())
    if status_code:
        query = query.eq("status_code", status_code)
    if search and search.strip():
        query = query.ilike("endpoint", f"%{search.strip()[:100]}%")
    return query


def fetch_logs(columns: str, **filters) -> List[Dict[str, Any]]:
    """Fetch ALL matching rows, paging past Supabase's 1000-row default limit."""
    db = get_db()
    rows: List[Dict[str, Any]] = []
    start = 0
    try:
        while start < MAX_ROWS:
            query = apply_filters(db.table("api_logs").select(columns), **filters)
            res = query.order("timestamp", desc=True).range(start, start + PAGE_SIZE - 1).execute()
            batch = res.data or []
            rows.extend(batch)
            if len(batch) < PAGE_SIZE:
                break
            start += PAGE_SIZE
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Database query failed")
        raise HTTPException(
            status_code=502,
            detail=(
                f"Database query failed ({type(exc).__name__}). Check that the 'api_logs' "
                "table exists and that your Supabase credentials are valid."
            ),
        )
    return rows


def percentile(values: List[float], p: float) -> float:
    return round(float(np.percentile(values, p)), 2) if values else 0.0


def empty_summary(days: int, rate: float) -> Dict[str, Any]:
    return {
        "total_requests": 0,
        "avg_latency_ms": 0,
        "p50_latency_ms": 0,
        "p95_latency_ms": 0,
        "p99_latency_ms": 0,
        "rate_limit_hits": 0,
        "error_count": 0,
        "error_rate": 0,
        "total_tokens": 0,
        "status_distribution": [],
        "current_spend": 0.0,
        "projected_monthly_cost": 0.0,
        "days": days,
        "cost_per_1k_tokens": rate,
    }


# ---------------------------------------------------------------------------
# Basic / config endpoints
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "database_configured": supabase is not None,
        "detail": None if supabase is not None else db_init_error,
    }


@app.get("/api/services")
def get_services():
    return SERVICES


@app.get("/api/tier-limits")
def get_tier_limits():
    return [{"tier": tier, **cfg} for tier, cfg in TIER_LIMITS.items()]


# ---------------------------------------------------------------------------
# Analytics endpoints
# ---------------------------------------------------------------------------
@app.get("/api/stats/summary")
def get_summary_stats(
    tier: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
    cost_per_1k_tokens: float = Query(DEFAULT_COST_PER_1K, ge=0),
):
    data = fetch_logs("latency_ms, status_code, tokens_used", tier=tier, service=service, days=days)
    total_requests = len(data)
    if total_requests == 0:
        return empty_summary(days, cost_per_1k_tokens)

    latencies = [num(r.get("latency_ms")) for r in data]
    status_counts: Dict[str, int] = {}
    rate_limit_hits = 0
    error_count = 0
    total_tokens = 0

    for row in data:
        code = int(num(row.get("status_code")))
        status_counts[str(code)] = status_counts.get(str(code), 0) + 1
        if code == 429:
            rate_limit_hits += 1
        if code >= 400:
            error_count += 1
        total_tokens += int(num(row.get("tokens_used")))

    # One cost formula used everywhere:
    #   current spend      = tokens / 1000 * rate
    #   monthly forecast  = current spend / days in the selected window * 30
    current_spend = (total_tokens / 1000) * cost_per_1k_tokens
    projected_monthly_cost = (current_spend / days) * 30

    return {
        "total_requests": total_requests,
        "avg_latency_ms": round(sum(latencies) / total_requests, 2),
        "p50_latency_ms": percentile(latencies, 50),
        "p95_latency_ms": percentile(latencies, 95),
        "p99_latency_ms": percentile(latencies, 99),
        "rate_limit_hits": rate_limit_hits,
        "error_count": error_count,
        "error_rate": round(error_count / total_requests * 100, 1),
        "total_tokens": total_tokens,
        "status_distribution": [
            {"name": f"HTTP {code}", "value": count}
            for code, count in sorted(status_counts.items(), key=lambda kv: int(kv[0]))
        ],
        "current_spend": round(current_spend, 4),
        "projected_monthly_cost": round(projected_monthly_cost, 4),
        "days": days,
        "cost_per_1k_tokens": cost_per_1k_tokens,
    }


@app.get("/api/stats/timeseries")
def get_timeseries(
    tier: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
):
    """Requests / errors over time. Hourly buckets for <= 2 days, daily otherwise."""
    rows = fetch_logs("timestamp, status_code, latency_ms", tier=tier, service=service, days=days)

    hourly = days <= 2
    step = timedelta(hours=1) if hourly else timedelta(days=1)

    def floor(dt: datetime) -> datetime:
        if hourly:
            return dt.replace(minute=0, second=0, microsecond=0)
        return dt.replace(hour=0, minute=0, second=0, microsecond=0)

    now = datetime.now(timezone.utc)
    buckets: Dict[datetime, Dict[str, Any]] = {}
    cursor, end = floor(now - timedelta(days=days)), floor(now)
    while cursor <= end:
        buckets[cursor] = {"requests": 0, "errors": 0, "rate_limited": 0, "latency_sum": 0.0}
        cursor += step

    for row in rows:
        ts = parse_ts(row.get("timestamp"))
        bucket = buckets.get(floor(ts)) if ts else None
        if bucket is None:
            continue
        code = int(num(row.get("status_code")))
        bucket["requests"] += 1
        bucket["latency_sum"] += num(row.get("latency_ms"))
        if code >= 400:
            bucket["errors"] += 1
        if code == 429:
            bucket["rate_limited"] += 1

    label_fmt = "%d %b %H:00" if hourly else "%d %b"
    return [
        {
            "bucket": key.isoformat(),
            "label": key.strftime(label_fmt),
            "requests": b["requests"],
            "errors": b["errors"],
            "rate_limited": b["rate_limited"],
            "avg_latency_ms": round(b["latency_sum"] / b["requests"], 1) if b["requests"] else 0,
        }
        for key, b in sorted(buckets.items())
    ]


@app.get("/api/stats/endpoints")
def get_endpoint_stats(
    tier: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
    cost_per_1k_tokens: float = Query(DEFAULT_COST_PER_1K, ge=0),
):
    data = fetch_logs(
        "endpoint, latency_ms, status_code, tokens_used", tier=tier, service=service, days=days
    )

    stats: Dict[str, Dict[str, Any]] = {}
    for row in data:
        ep = row.get("endpoint") or "unknown"
        item = stats.setdefault(ep, {"calls": 0, "latencies": [], "errors": 0, "tokens": 0})
        item["calls"] += 1
        item["latencies"].append(num(row.get("latency_ms")))
        item["tokens"] += int(num(row.get("tokens_used")))
        if num(row.get("status_code")) >= 400:
            item["errors"] += 1

    result = []
    for ep, item in stats.items():
        calls = item["calls"]
        result.append(
            {
                "endpoint": ep,
                "total_calls": calls,
                "avg_latency_ms": round(sum(item["latencies"]) / calls, 2),
                "p95_latency_ms": percentile(item["latencies"], 95),
                "error_count": item["errors"],
                "error_rate": round(item["errors"] / calls * 100, 1),
                "tokens_used": item["tokens"],
                "estimated_cost": round(item["tokens"] / 1000 * cost_per_1k_tokens, 4),
            }
        )
    return sorted(result, key=lambda x: x["total_calls"], reverse=True)


@app.get("/api/logs")
def get_request_logs(
    endpoint: Optional[str] = Query(None),
    search: Optional[str] = Query(None, description="Partial match on the endpoint path"),
    status_code: Optional[int] = Query(None, ge=100, le=599),
    tier: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    days: Optional[int] = Query(None, ge=1, le=90),
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    db = get_db()
    try:
        query = db.table("api_logs").select("*", count="exact")
        query = apply_filters(
            query,
            tier=tier,
            service=service,
            days=days,
            endpoint=endpoint,
            status_code=status_code,
            search=search,
        )
        res = query.order("timestamp", desc=True).range(offset, offset + limit - 1).execute()
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.exception("Log query failed")
        raise HTTPException(
            status_code=502,
            detail=f"Could not load request logs ({type(exc).__name__}). Check the database connection.",
        )

    items = res.data or []
    total = getattr(res, "count", None)
    return {
        "items": items,
        "total": total if isinstance(total, int) else offset + len(items),
        "limit": limit,
        "offset": offset,
    }


# ---------------------------------------------------------------------------
# Simulators
# ---------------------------------------------------------------------------
@app.get("/api/simulate/cache-and-limits")
def simulate_cache_and_limits(
    cache_hit_ratio: float = Query(0.30, ge=0.0, le=1.0),
    cost_per_1k_tokens: float = Query(DEFAULT_COST_PER_1K, ge=0),
    tier: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
):
    data = fetch_logs("latency_ms, tokens_used", tier=tier, service=service, days=days)
    total_requests = len(data)
    if total_requests == 0:
        return {"has_data": False, "cache_hit_ratio_pct": int(cache_hit_ratio * 100)}

    total_tokens = sum(int(num(r.get("tokens_used"))) for r in data)
    avg_latency = sum(num(r.get("latency_ms")) for r in data) / total_requests

    cached_requests = int(total_requests * cache_hit_ratio)
    uncached_requests = total_requests - cached_requests

    simulated_tokens = int(total_tokens * (1 - cache_hit_ratio))
    original_cost = (total_tokens / 1000) * cost_per_1k_tokens
    simulated_cost = (simulated_tokens / 1000) * cost_per_1k_tokens

    simulated_avg_latency = (
        (uncached_requests * avg_latency) + (cached_requests * CACHED_RESPONSE_LATENCY_MS)
    ) / total_requests
    latency_reduction_pct = (
        (avg_latency - simulated_avg_latency) / avg_latency * 100 if avg_latency > 0 else 0
    )

    savings = original_cost - simulated_cost
    return {
        "has_data": True,
        "total_requests": total_requests,
        "cached_requests": cached_requests,
        "cache_hit_ratio_pct": int(round(cache_hit_ratio * 100)),
        "original_cost": round(original_cost, 4),
        "simulated_cost": round(simulated_cost, 4),
        "cost_savings": round(savings, 4),
        "projected_monthly_savings": round(savings / days * 30, 4),
        "original_avg_latency_ms": round(avg_latency, 2),
        "simulated_avg_latency_ms": round(simulated_avg_latency, 2),
        "latency_reduction_pct": round(latency_reduction_pct, 1),
        "tokens_saved": total_tokens - simulated_tokens,
    }


@app.get("/api/simulate/rate-limit")
def simulate_rate_limit(
    tier: str = Query("free"),
    simulated_request_count: int = Query(12, ge=0, le=1_000_000),
):
    key = (tier or "").strip().lower()
    if key not in TIER_LIMITS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown tier '{tier}'. Use one of: {', '.join(TIER_LIMITS)}.",
        )

    cfg = TIER_LIMITS[key]
    limit, window = cfg["limit"], cfg["window_sec"]
    usage_pct = round(simulated_request_count / limit * 100, 1)

    if simulated_request_count > limit:
        headers = {
            "Retry-After": str(window),
            "X-RateLimit-Limit": str(limit),
            "X-RateLimit-Remaining": "0",
        }
        return JSONResponse(
            status_code=429,
            headers=headers,
            content={
                "status": 429,
                "error": "Too Many Requests",
                "message": (
                    f"Rate limit of {limit} requests per {window}s exceeded for the "
                    f"{key.upper()} tier. Wait for the window to reset before retrying."
                ),
                "retry_after_sec": window,
                "tier_limit": limit,
                "window_sec": window,
                "remaining_quota": 0,
                "requested_count": simulated_request_count,
                "usage_pct": usage_pct,
            },
        )

    remaining = limit - simulated_request_count
    return JSONResponse(
        status_code=200,
        headers={"X-RateLimit-Limit": str(limit), "X-RateLimit-Remaining": str(remaining)},
        content={
            "status": 200,
            "message": f"Request accepted. It fits within the {key.upper()} tier quota.",
            "remaining_quota": remaining,
            "tier_limit": limit,
            "window_sec": window,
            "requested_count": simulated_request_count,
            "usage_pct": usage_pct,
        },
    )


# ---------------------------------------------------------------------------
# Recommendations
# ---------------------------------------------------------------------------
@app.get("/api/recommendations")
def get_cost_recommendations(
    tier: Optional[str] = Query(None),
    service: Optional[str] = Query(None),
    days: int = Query(7, ge=1, le=90),
):
    data = fetch_logs("endpoint, latency_ms, status_code, tokens_used", tier=tier, service=service, days=days)
    if not data:
        return []

    ep_stats: Dict[str, Dict[str, Any]] = {}
    total_tokens = 0
    total_429s = 0

    for row in data:
        ep = row.get("endpoint") or "unknown"
        tokens = int(num(row.get("tokens_used")))
        total_tokens += tokens
        if int(num(row.get("status_code"))) == 429:
            total_429s += 1
        item = ep_stats.setdefault(ep, {"tokens": 0, "latencies": []})
        item["tokens"] += tokens
        item["latencies"].append(num(row.get("latency_ms")))

    recommendations: List[Dict[str, Any]] = []

    if total_tokens > 0:
        for ep, item in ep_stats.items():
            share = item["tokens"] / total_tokens
            if share > 0.4 and item["tokens"] > 50000:
                recommendations.append(
                    {
                        "id": f"rec_high_tokens_{ep}",
                        "type": "warning",
                        "title": f"High token use on {ep}",
                        "impact": "High savings potential",
                        "description": (
                            f"This endpoint accounts for {int(share * 100)}% of all tokens used. "
                            "Cache repeated responses or use a smaller model for simple requests."
                        ),
                    }
                )

    if total_429s > 10:
        share_429 = round(total_429s / len(data) * 100, 1)
        recommendations.append(
            {
                "id": "rec_rate_limits",
                "type": "error",
                "title": "Frequent rate-limit rejections (HTTP 429)",
                "impact": "Reliability and user experience",
                "description": (
                    f"{total_429s} requests ({share_429}%) were rejected. Add exponential backoff "
                    "retries to clients, or review whether the free-tier limit is too strict."
                ),
            }
        )

    for ep, item in ep_stats.items():
        avg_lat = sum(item["latencies"]) / len(item["latencies"])
        if avg_lat > 1000:
            recommendations.append(
                {
                    "id": f"rec_high_latency_{ep}",
                    "type": "info",
                    "title": f"Slow responses on {ep}",
                    "impact": "Performance bottleneck",
                    "description": (
                        f"Average latency is {round(avg_lat, 1)} ms. Edge caching or streaming "
                        "responses can improve how fast the endpoint feels."
                    ),
                }
            )

    if not recommendations:
        recommendations.append(
            {
                "id": "rec_optimal",
                "type": "success",
                "title": "Cost and latency look healthy",
                "impact": "Nominal performance",
                "description": "No cost or latency bottlenecks were found in the selected data.",
            }
        )

    return recommendations
"""
Populate the Supabase `api_logs` table with realistic synthetic API telemetry.

Usage:
    python seed.py                    # insert 1000 logs spread over the last 7 days
    python seed.py --count 3000       # insert more logs
    python seed.py --days 30          # spread them over 30 days
    python seed.py --reset            # delete ALL existing rows first, then insert

Why timestamps matter: the dashboard filters by time range and forecasts the
monthly cost from the selected window, so logs must be spread over several days
(the previous version stamped every row with "now").
"""

import argparse
import os
import random
import sys
from datetime import datetime, timedelta, timezone

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()

SERVICES = ["LLM Inference API", "Payment Gateway", "Auth Service"]

ENDPOINTS = [
    ("/v1/chat/completions", "POST"),
    ("/v1/embeddings", "POST"),
    ("/v1/images/generations", "POST"),
    ("/v1/models", "GET"),
    ("/v1/audio/transcriptions", "POST"),
]

USER_TIERS = ["free", "pro", "enterprise"]
TIER_WEIGHTS = [0.6, 0.3, 0.1]

# Free users hit rate limits far more often than paying users.
RATE_LIMIT_CHANCE = {"free": 0.16, "pro": 0.05, "enterprise": 0.01}
SERVER_ERROR_CHANCE = 0.02

# Busier during the day, quiet at night (index = hour of day, UTC).
HOUR_WEIGHTS = [1, 1, 1, 1, 1, 2, 3, 5, 7, 8, 9, 9, 9, 9, 9, 8, 8, 7, 6, 5, 4, 3, 2, 1]


def get_client() -> Client:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        sys.exit("Missing SUPABASE_URL or SUPABASE_KEY. Add both to the .env file in this folder.")
    try:
        return create_client(url, key)
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"Could not connect to Supabase ({type(exc).__name__}): {exc}")


def random_timestamp(now: datetime, days: int) -> datetime:
    """A random moment inside the last `days` days, weighted toward daytime."""
    earliest = now - timedelta(days=days)
    while True:
        day_offset = random.randint(0, days - 1)
        hour = random.choices(range(24), weights=HOUR_WEIGHTS)[0]
        candidate = (now - timedelta(days=day_offset)).replace(
            hour=hour, minute=random.randint(0, 59), second=random.randint(0, 59), microsecond=0
        )
        if earliest <= candidate <= now:
            return candidate


def build_logs(count: int, days: int) -> list:
    now = datetime.now(timezone.utc)
    logs = []

    for _ in range(count):
        service = random.choice(SERVICES)
        endpoint, method = random.choice(ENDPOINTS)
        tier = random.choices(USER_TIERS, weights=TIER_WEIGHTS)[0]

        roll = random.random()
        if roll < RATE_LIMIT_CHANCE[tier]:
            status_code = 429
        elif roll < RATE_LIMIT_CHANCE[tier] + SERVER_ERROR_CHANCE:
            status_code = 500
        else:
            status_code = 200

        if "images" in endpoint:
            latency_ms = random.randint(1200, 3500)
        elif "chat" in endpoint:
            latency_ms = random.randint(300, 1500)
        else:
            latency_ms = random.randint(40, 250)

        # Rate-limited calls are rejected quickly and consume no tokens.
        if status_code == 429:
            latency_ms = random.randint(10, 50)
            tokens = 0
        else:
            tokens = random.randint(100, 2500) if method == "POST" else 0

        logs.append(
            {
                "service_name": service,
                "endpoint": endpoint,
                "method": method,
                "status_code": status_code,
                "latency_ms": latency_ms,
                "user_tier": tier,
                "tokens_used": tokens,
                "timestamp": random_timestamp(now, days).isoformat(),
            }
        )

    logs.sort(key=lambda row: row["timestamp"])
    return logs


def reset_table(client: Client) -> None:
    print("Deleting existing rows from api_logs...")
    try:
        # latency_ms is always >= 0, so this matches (and removes) every row.
        client.table("api_logs").delete().gte("latency_ms", 0).execute()
    except Exception as exc:  # noqa: BLE001
        sys.exit(f"Could not clear api_logs ({type(exc).__name__}): {exc}")


def seed(count: int, days: int, reset: bool) -> None:
    client = get_client()
    if reset:
        reset_table(client)

    print(f"Generating {count} mock API logs across {len(SERVICES)} services over the last {days} days...")
    logs = build_logs(count, days)

    chunk_size = 200
    for start in range(0, len(logs), chunk_size):
        chunk = logs[start:start + chunk_size]
        try:
            client.table("api_logs").insert(chunk).execute()
        except Exception as exc:  # noqa: BLE001
            sys.exit(
                f"Insert failed at row {start + 1} ({type(exc).__name__}): {exc}\n"
                "Check that the api_logs table exists with these columns: service_name, endpoint, "
                "method, status_code, latency_ms, user_tier, tokens_used, timestamp."
            )
        print(f"Inserted logs {start + 1} to {min(start + chunk_size, len(logs))}")

    print("Seeding completed successfully!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed the api_logs table with mock telemetry.")
    parser.add_argument("--count", type=int, default=1000, help="number of logs to insert (default 1000)")
    parser.add_argument("--days", type=int, default=7, help="spread logs over this many days (default 7)")
    parser.add_argument("--reset", action="store_true", help="delete all existing rows before inserting")
    args = parser.parse_args()

    if args.count < 1 or args.days < 1:
        sys.exit("--count and --days must both be at least 1.")

    seed(args.count, args.days, args.reset)
#!/usr/bin/env python3
"""
Fast, dependency-free updater for OpenAPI JSON files.

Improvements over the simple version:
- Parallel downloads (ThreadPoolExecutor)
- Conditional GET using cached ETag/Last-Modified (304 Not Modified)
- Retries with exponential backoff for transient errors
- Timeouts and gzip support
- Atomic writes; skip write if content unchanged
- Exit code indicates overall success
- All stdlib only

Env vars:
  OPENAPI_CONCURRENCY (int) default: min(8, len(ENDPOINTS))
  OPENAPI_TIMEOUT     (int) seconds, default: 20
  OPENAPI_RETRIES     (int) attempts, default: 3
"""

from __future__ import annotations
import json
import os
import sys
import time
import threading
import urllib.request
import urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, Tuple, Any, Optional

# -------- Config --------

GATEWAY_URL = os.environ.get("GATEWAY_URL", "").rstrip("/")
if not GATEWAY_URL:
    raise SystemExit("Error: GATEWAY_URL environment variable is required.")

_default_services = os.environ.get("OPENAPI_SERVICES", "")
if not _default_services.strip():
    raise SystemExit("Error: OPENAPI_SERVICES environment variable is required (comma-separated service names).")

_service_list = [s.strip() for s in _default_services.split(",") if s.strip()]

# Each service is expected at {GATEWAY_URL}/{service-name}/openapi.json
# Override individual URLs via OPENAPI_URL_<SERVICE_NAME_UPPER> if needed.
ENDPOINTS: Dict[str, str] = {
    svc: os.environ.get(f"OPENAPI_URL_{svc.upper().replace('-', '_')}", f"{GATEWAY_URL}/{svc}/openapi.json")
    for svc in _service_list
}

# Resolve api/ relative to this script's location so it works from any cwd
API_DIR = Path(__file__).parent / "api"
CACHE_FILE = API_DIR / ".openapi_headers.json"  # stores ETag/Last-Modified per service

# Tunables via environment
def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, "").strip() or default)
        return v if v > 0 else default
    except Exception:
        return default

CONCURRENCY = _env_int("OPENAPI_CONCURRENCY", min(8, len(ENDPOINTS)))
TIMEOUT = _env_int("OPENAPI_TIMEOUT", 20)
RETRIES = _env_int("OPENAPI_RETRIES", 3)

UA = "Mozilla/5.0 (compatible; OpenAPI-Updater/2.0; +stdlib)"
ACCEPT = "application/json, */*;q=0.8"
ACCEPT_ENCODING = "gzip, deflate"

# -------- Helpers --------

_headers_lock = threading.Lock()

def load_cache() -> Dict[str, Dict[str, str]]:
    if not CACHE_FILE.exists():
        return {}
    try:
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}

def save_cache(cache: Dict[str, Dict[str, str]]) -> None:
    tmp = CACHE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cache, f, indent=2, ensure_ascii=False)
    os.replace(tmp, CACHE_FILE)

def _canonical(obj: Any) -> str:
    """Stable JSON string for comparison (fast enough for OpenAPI sizes)."""
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=False)

def _read_json_file(path: Path) -> Optional[Any]:
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def _atomic_write_json(path: Path, data: Any, pretty: bool = True) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        else:
            json.dump(data, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, path)

def _should_retry(e: Exception) -> bool:
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (429, 500, 502, 503, 504)
    if isinstance(e, urllib.error.URLError):
        return True
    return False

# -------- Core fetch --------

def fetch_one(service: str, url: str, cache: Dict[str, Dict[str, str]]) -> Tuple[str, bool, str]:
    """
    Returns: (service_name, success, message)
    success=True also for 304 Not Modified.
    """
    with _headers_lock:
        meta = cache.get(service, {})
    req_headers = {
        "User-Agent": UA,
        "Accept": ACCEPT,
        "Accept-Encoding": ACCEPT_ENCODING,
    }
    if "etag" in meta:
        req_headers["If-None-Match"] = meta["etag"]
    if "last_modified" in meta:
        req_headers["If-Modified-Since"] = meta["last_modified"]

    attempt = 0
    backoff = 0.6
    while True:
        attempt += 1
        try:
            req = urllib.request.Request(url, headers=req_headers, method="GET")
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read()
                text = raw.decode("utf-8-sig")
                obj = json.loads(text)

                out_path = API_DIR / f"{service}-openapi.json"
                old_obj = _read_json_file(out_path)
                if old_obj is not None and _canonical(old_obj) == _canonical(obj):
                    etag = resp.headers.get("ETag", "")
                    last_mod = resp.headers.get("Last-Modified", "")
                    with _headers_lock:
                        cache[service] = {"etag": etag, "last_modified": last_mod}
                    return service, True, "unchanged (content matches)"

                _atomic_write_json(out_path, obj, pretty=True)

                etag = resp.headers.get("ETag", "")
                last_mod = resp.headers.get("Last-Modified", "")
                with _headers_lock:
                    cache[service] = {"etag": etag, "last_modified": last_mod}

                return service, True, f"updated -> {out_path}"

        except urllib.error.HTTPError as e:
            if e.code == 304:
                return service, True, "not modified (ETag/Last-Modified)"
            if _should_retry(e) and attempt < RETRIES:
                time.sleep(backoff)
                backoff *= 2
                continue
            return service, False, f"HTTP {e.code}: {e.reason}"
        except json.JSONDecodeError as e:
            return service, False, f"invalid JSON: {e}"
        except Exception as e:
            if _should_retry(e) and attempt < RETRIES:
                time.sleep(backoff)
                backoff *= 2
                continue
            return service, False, f"{type(e).__name__}: {e}"

# -------- Main --------

def main() -> int:
    print("Starting OpenAPI update...")
    print("=" * 64)
    API_DIR.mkdir(parents=True, exist_ok=True)

    cache = load_cache()
    results = []

    items = sorted(ENDPOINTS.items(), key=lambda kv: kv[0])

    with ThreadPoolExecutor(max_workers=max(1, CONCURRENCY)) as pool:
        futures = {pool.submit(fetch_one, name, url, cache): name for name, url in items}
        for fut in as_completed(futures):
            name = futures[fut]
            try:
                service, ok, msg = fut.result()
                status = "OK" if ok else "FAIL"
                print(f"[{status}] {service}: {msg}")
            except Exception as e:
                print(f"[FAIL] {name}: unexpected error in worker: {e}")
                results.append(False)
            else:
                results.append(ok)

    save_cache(cache)

    print("=" * 64)
    success_count = sum(1 for ok in results if ok)
    total = len(items)
    print(f"Done: {success_count}/{total} services OK")
    if success_count == total:
        print("All OpenAPI files are up to date.")
        return 0
    else:
        print("Some updates failed. See messages above.")
        return 1

if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
Fast, dependency-free updater for the Canvas LMS API specs.

Canvas does not publish an OpenAPI 3 document. It does serve its full API
documentation as Swagger 1.2 at {CANVAS_URL}/doc/api/, one JSON file per
resource. This script downloads those files and converts them to OpenAPI 3.0.3,
writing one self-contained spec per resource into api/ so the MCP server sees
each Canvas resource as a "service".

Notes:
- Canvas hardcodes basePath to canvas.instructure.com in every file; servers[]
  is rebuilt from CANVAS_URL instead.
- Models are per-resource in Swagger 1.2, but operations reference models owned
  by other resources. Foreign models are copied in (transitively) so every
  emitted spec resolves its own $refs.
- No conditional GET: the global model index needs every document on each run.
  Files whose converted output is unchanged are not rewritten.

Env vars:
  CANVAS_URL          (str) Canvas base URL, default: https://na.instructure.com
  CANVAS_RESOURCES    (str) optional comma-separated subset of resource names
  OPENAPI_CONCURRENCY (int) default: 8
  OPENAPI_TIMEOUT     (int) seconds, default: 30
  OPENAPI_RETRIES     (int) attempts, default: 3
"""

from __future__ import annotations
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import gzip
import zlib
import io
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional, Set, Tuple

# -------- Config --------

CANVAS_URL = os.environ.get("CANVAS_URL", "https://na.instructure.com").strip().rstrip("/")
if not CANVAS_URL:
    raise SystemExit("Error: CANVAS_URL must not be empty.")

DOC_BASE = f"{CANVAS_URL}/doc/api"
SERVER_URL = f"{CANVAS_URL}/api"

API_DIR = Path(__file__).parent / "api"

_subset = os.environ.get("CANVAS_RESOURCES", "")
RESOURCE_FILTER = {s.strip() for s in _subset.split(",") if s.strip()}


def _env_int(name: str, default: int) -> int:
    try:
        v = int(os.environ.get(name, "").strip() or default)
        return v if v > 0 else default
    except Exception:
        return default


CONCURRENCY = _env_int("OPENAPI_CONCURRENCY", 8)
TIMEOUT = _env_int("OPENAPI_TIMEOUT", 30)
RETRIES = _env_int("OPENAPI_RETRIES", 3)

UA = "Mozilla/5.0 (compatible; Canvas-OpenAPI-Updater/1.0; +stdlib)"
REQ_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json, */*;q=0.8",
    "Accept-Encoding": "gzip, deflate",
}

SCHEMA_PREFIX = "#/components/schemas/"

# -------- Type mapping (Swagger 1.2 / Canvas YARD -> OpenAPI 3) --------

PRIMITIVES: Dict[str, Dict[str, Any]] = {
    "string": {"type": "string"},
    "str": {"type": "string"},
    "text": {"type": "string"},
    "integer": {"type": "integer"},
    "int": {"type": "integer"},
    "positive integer": {"type": "integer", "minimum": 1},
    "number": {"type": "number"},
    "numeric": {"type": "number"},
    "float": {"type": "number", "format": "float"},
    "boolean": {"type": "boolean"},
    "bool": {"type": "boolean"},
    "datetime": {"type": "string", "format": "date-time"},
    "date": {"type": "string", "format": "date"},
    "uuid": {"type": "string", "format": "uuid"},
    "url": {"type": "string", "format": "uri"},
    "file": {"type": "string", "format": "binary"},
    "object": {"type": "object"},
    "hash": {"type": "object"},
    "serializedhash": {"type": "object"},
    "json": {"type": "object"},
    "array": {"type": "array"},
    "string[]": {"type": "array", "items": {"type": "string"}},
    "variable": {},
    "none": {},
}

_API_LINK = re.compile(r"\{api:[A-Za-z0-9_:#]+\s+([^}]+)\}")


def clean_text(s: Any) -> str:
    """Strip Canvas YARD {api:Controller#action Link Text} markup down to its label."""
    if not isinstance(s, str):
        return ""
    return _API_LINK.sub(r"\1", s).strip()


def slugify(name: str) -> str:
    """'/accounts_(lti).json' -> 'accounts_lti'"""
    base = name.rsplit("/", 1)[-1]
    if base.endswith(".json"):
        base = base[: -len(".json")]
    base = re.sub(r"[^A-Za-z0-9]+", "_", base).strip("_").lower()
    return base or "unnamed"


def ref_schema(name: str) -> Dict[str, Any]:
    safe = str(name).replace("~", "~0").replace("/", "~1")
    return {"$ref": SCHEMA_PREFIX + safe}


def ref_or_schema(name: Any, known_models: Set[str]) -> Dict[str, Any]:
    """A Swagger 1.2 $ref value is usually a model name, but Canvas sometimes
    puts a bare type ("Array", "Hash") or free prose there instead."""
    if isinstance(name, str) and name in known_models:
        return ref_schema(name)
    return schema_for(name, None, known_models)


def schema_for(raw_type: Any, items: Any, known_models: Set[str]) -> Dict[str, Any]:
    """Map one Swagger 1.2 type (plus optional items) onto an OpenAPI 3 schema."""
    # Canvas occasionally emits a JSON list for a nullable type, e.g. ['string', 'null'].
    if isinstance(raw_type, list):
        non_null = [t for t in raw_type if str(t).lower() != "null"]
        out = schema_for(non_null[0] if non_null else None, items, known_models)
        if len(non_null) != len(raw_type):
            out["nullable"] = True
        return out

    if raw_type is None or not str(raw_type).strip():
        return {}

    original = str(raw_type).strip()
    key = original.lower()

    def items_schema() -> Dict[str, Any]:
        if isinstance(items, dict):
            if "$ref" in items:
                return ref_or_schema(items["$ref"], known_models)
            if "type" in items:
                return schema_for(items["type"], items.get("items"), known_models)
        return {}

    if key in PRIMITIVES:
        out = dict(PRIMITIVES[key])
        if out.get("type") == "array" and "items" not in out:
            out["items"] = items_schema()
        return out

    # A model name, e.g. "Assignment"
    if original in known_models:
        return ref_schema(original)

    # "multiple BlueprintRestrictions" / "[Answer]" / "Answer[]" -> array of model
    inner: Optional[str] = None
    if key.startswith("multiple "):
        inner = original[len("multiple "):].strip()
    elif original.startswith("[") and original.endswith("]"):
        inner = original[1:-1].strip()
    elif original.endswith("[]"):
        inner = original[:-2].strip()
    if inner:
        if inner not in known_models and inner.endswith("s") and inner[:-1] in known_models:
            inner = inner[:-1]
        return {"type": "array", "items": schema_for(inner, None, known_models)}

    # "string|User" -> oneOf
    if "|" in original:
        parts = [p.strip() for p in original.split("|") if p.strip()]
        return {"oneOf": [schema_for(p, None, known_models) for p in parts]}

    # Prose that leads with a model name, e.g.
    # "BlackoutDate The result (which should match the input...)"
    head = re.split(r"[\s,(]", original, 1)[0].strip()
    if head in known_models:
        return ref_schema(head)

    # "list of content items" / "array of outcome ids"
    if key.startswith("list of ") or key.startswith("array of "):
        inner_name = original.split(" of ", 1)[1].strip()
        return {"type": "array", "items": ref_schema(inner_name) if inner_name in known_models else {}}

    # A status line where a payload was expected, e.g. "204 No Content"
    if re.match(r"^\d{3}\b", original):
        return {}

    # An inline shape, e.g. "{Object} Hash with id and messages array" or '{ "count": "integer" }'
    if original.startswith("{Object}"):
        rest = original[len("{Object}"):].strip()
        out = {"type": "object"}
        if rest:
            out["description"] = rest
        return out
    if original.startswith("{"):
        return {"type": "object", "description": f"Canvas type: {original}"}

    # A model-looking name Canvas references but never documents, e.g. "RollupJob"
    if re.match(r"^[A-Z][A-Za-z0-9_]*(::[A-Za-z0-9_]+)*$", original):
        return {
            "type": "object",
            "description": f"Canvas type: {original} (referenced but not defined in Canvas's published models)",
        }

    # Unknown Canvas type: fall back to string but keep the original name visible.
    return {"type": "string", "description": f"Canvas type: {original}"}


def apply_enum(schema: Dict[str, Any], values: Any) -> None:
    """An enum constrains the element type, not the container, so on an array
    schema it belongs on items."""
    if not values:
        return
    if schema.get("type") == "array":
        items = schema.setdefault("items", {})
        if isinstance(items, dict) and "$ref" not in items:
            items["enum"] = values
    else:
        schema["enum"] = values


def sanitize_example(value: Any) -> Any:
    """Canvas embeds {"$ref": "SomeModel"} inside example payloads. Left as-is
    those look like real references to any OpenAPI consumer, so collapse them
    into a readable placeholder."""
    if isinstance(value, dict):
        if set(value.keys()) == {"$ref"} and isinstance(value["$ref"], str):
            return f"<{value['$ref']} object>"
        return {k: sanitize_example(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitize_example(v) for v in value]
    return value


def convert_property(prop: Dict[str, Any], known_models: Set[str]) -> Dict[str, Any]:
    if "$ref" in prop:
        out = ref_or_schema(prop["$ref"], known_models)
        # A $ref sibling is invalid in OpenAPI 3.0, so description is dropped here.
        return out

    items = prop.get("items")
    # Canvas emits the odd malformed array whose items live under a stray key,
    # e.g. {"type": "array", "modules": {"$ref": "Module"}}
    if prop.get("type") == "array" and not items:
        for k, v in prop.items():
            if k not in ("type", "description", "example", "format", "default") and isinstance(v, dict) and "$ref" in v:
                items = v
                break

    # A map/dictionary property: {"type": "object", "key": {...}, "value": {...}}
    if isinstance(prop.get("value"), dict) and isinstance(prop.get("key"), dict):
        out: Dict[str, Any] = {
            "type": "object",
            "additionalProperties": schema_for(prop["value"].get("type"), prop["value"].get("items"), known_models),
        }
    else:
        out = schema_for(prop.get("type"), items, known_models)

    desc = clean_text(prop.get("description"))
    if desc:
        out["description"] = desc
    if prop.get("example") is not None:
        out["example"] = sanitize_example(prop["example"])
    if prop.get("format"):
        out["format"] = prop["format"]
    if prop.get("default") is not None:
        out["default"] = prop["default"]
    for bound in ("minimum", "maximum"):
        if prop.get(bound) is not None:
            out[bound] = prop[bound]

    enum = prop.get("enum")
    if not enum and isinstance(prop.get("allowableValues"), dict):
        enum = prop["allowableValues"].get("values")
    apply_enum(out, enum)
    if isinstance(prop.get("properties"), dict):
        out["properties"] = {
            k: convert_property(v, known_models) for k, v in prop["properties"].items()
        }
    return out


def convert_model(model: Dict[str, Any], known_models: Set[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {"type": "object"}
    desc = clean_text(model.get("description"))
    if desc:
        out["description"] = desc
    props = model.get("properties") or {}
    if props:
        out["properties"] = {k: convert_property(v, known_models) for k, v in props.items()}
    if model.get("required"):
        out["required"] = model["required"]
    if model.get("deprecated"):
        out["deprecated"] = True
    return out


def convert_parameter(param: Dict[str, Any], known_models: Set[str]) -> Dict[str, Any]:
    schema = schema_for(param.get("type"), param.get("items"), known_models)
    apply_enum(schema, param.get("enum"))
    if param.get("format"):
        schema["format"] = param["format"]
    out: Dict[str, Any] = {
        "name": param.get("name", ""),
        "in": "path" if param.get("paramType") == "path" else "query",
        "required": True if param.get("paramType") == "path" else bool(param.get("required")),
        "schema": schema,
    }
    desc = clean_text(param.get("description"))
    if desc:
        out["description"] = desc
    if param.get("deprecated"):
        out["deprecated"] = True
    return out


def build_request_body(form_params: List[Dict[str, Any]], known_models: Set[str]) -> Dict[str, Any]:
    """Canvas takes POST/PUT bodies as form encoding; nested names like
    course[name] are kept verbatim because that is what the API expects."""
    properties: Dict[str, Any] = {}
    required: List[str] = []
    for p in form_params:
        name = p.get("name", "")
        if not name:
            continue
        schema = schema_for(p.get("type"), p.get("items"), known_models)
        apply_enum(schema, p.get("enum"))
        desc = clean_text(p.get("description"))
        if desc:
            schema["description"] = desc
        if p.get("deprecated"):
            schema["deprecated"] = True
        properties[name] = schema
        if p.get("required"):
            required.append(name)
    body_schema: Dict[str, Any] = {"type": "object", "properties": properties}
    if required:
        body_schema["required"] = required
    return {
        "required": bool(required),
        "content": {
            "application/x-www-form-urlencoded": {"schema": body_schema},
            "application/json": {"schema": body_schema},
        },
    }


def build_responses(op: Dict[str, Any], known_models: Set[str]) -> Dict[str, Any]:
    lines = []
    for field in op.get("response_fields") or []:
        if isinstance(field, dict) and field.get("name"):
            fdesc = clean_text(field.get("description")).replace("\n", " ")
            lines.append(f"- {field['name']}: {fdesc}" if fdesc else f"- {field['name']}")
    description = "Successful response"
    if lines:
        description += "\n\nResponse fields:\n" + "\n".join(lines)

    raw_type = op.get("type")
    if not raw_type or str(raw_type).lower() == "void":
        return {"200": {"description": description}}

    schema = schema_for(raw_type, op.get("items"), known_models)
    if not schema:
        return {"200": {"description": description}}
    return {
        "200": {
            "description": description,
            "content": {"application/json": {"schema": schema}},
        }
    }


def convert_resource(
    slug: str, title: str, doc: Dict[str, Any], known_models: Set[str]
) -> Dict[str, Any]:
    paths: Dict[str, Any] = {}
    seen_ids: Dict[str, int] = {}

    for api in doc.get("apis", []) or []:
        path = api.get("path", "")
        if not path:
            continue
        entry = paths.setdefault(path, {})
        for op in api.get("operations", []) or []:
            method = str(op.get("method", "get")).lower()
            if method not in ("get", "put", "post", "delete", "patch", "head", "options"):
                continue

            operation_id = op.get("nickname") or f"{method}_{slugify(path)}"
            seen_ids[operation_id] = seen_ids.get(operation_id, 0) + 1
            if seen_ids[operation_id] > 1:
                operation_id = f"{operation_id}_{seen_ids[operation_id]}"

            params = op.get("parameters", []) or []
            form_params = [p for p in params if p.get("paramType") == "form"]
            other_params = [p for p in params if p.get("paramType") in ("path", "query")]

            description = clean_text(op.get("notes"))
            if op.get("deprecation_description"):
                dep = clean_text(op["deprecation_description"])
                description = (description + "\n\nDeprecated: " + dep).strip()

            operation: Dict[str, Any] = {
                "operationId": operation_id,
                "summary": clean_text(op.get("summary")) or operation_id,
                "tags": [title],
                "responses": build_responses(op, known_models),
            }
            if description:
                operation["description"] = description
            if other_params:
                operation["parameters"] = [convert_parameter(p, known_models) for p in other_params]
            if form_params:
                operation["requestBody"] = build_request_body(form_params, known_models)
            if op.get("deprecated"):
                operation["deprecated"] = True

            entry[method] = operation

        api_desc = clean_text(api.get("description"))
        if api_desc and "description" not in entry:
            entry["description"] = api_desc

    return {
        "openapi": "3.0.3",
        "info": {
            "title": f"Canvas LMS — {title}",
            "version": str(doc.get("apiVersion") or "1.0"),
            "description": (
                f"Canvas LMS REST API — {title}. Converted from the Swagger 1.2 "
                f"documentation served at {DOC_BASE}."
            ),
        },
        "servers": [{"url": SERVER_URL, "description": "Canvas instance"}],
        "tags": [{"name": title}],
        "security": [{"bearerAuth": []}],
        "paths": paths,
        "components": {
            "securitySchemes": {
                "bearerAuth": {"type": "http", "scheme": "bearer", "description": "Canvas API access token"}
            },
            "schemas": {},
        },
    }


def collect_refs(node: Any, out: Set[str]) -> None:
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith(SCHEMA_PREFIX):
            out.add(ref[len(SCHEMA_PREFIX):].replace("~1", "/").replace("~0", "~"))
        for v in node.values():
            collect_refs(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_refs(v, out)


# -------- Fetching --------

def _should_retry(e: Exception) -> bool:
    if isinstance(e, urllib.error.HTTPError):
        return e.code in (429, 500, 502, 503, 504)
    if isinstance(e, urllib.error.URLError):
        return True
    return False


def _decompress(raw: bytes, encoding: str) -> bytes:
    encoding = (encoding or "").lower().strip()
    if encoding == "gzip":
        return gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
    if encoding == "deflate":
        try:
            return zlib.decompress(raw)
        except zlib.error:
            return zlib.decompress(raw, -zlib.MAX_WBITS)
    return raw


def fetch_json(url: str) -> Any:
    attempt = 0
    backoff = 0.6
    while True:
        attempt += 1
        try:
            req = urllib.request.Request(url, headers=REQ_HEADERS, method="GET")
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = _decompress(resp.read(), resp.headers.get("Content-Encoding", ""))
                return json.loads(raw.decode("utf-8-sig"))
        except Exception as e:
            if _should_retry(e) and attempt < RETRIES:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise


def _canonical(obj: Any) -> str:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=False)


def _read_json_file(path: Path) -> Optional[Any]:
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _atomic_write_json(path: Path, data: Any) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


# -------- Main --------

def pick_model_owner(name: str, candidates: List[Tuple[str, Dict[str, Any]]]) -> Dict[str, Any]:
    """Several resources may define the same model name with different shapes.
    Prefer the resource whose slug matches the model name, then the definition
    with the most properties, then alphabetical order for determinism."""
    if len(candidates) == 1:
        return candidates[0][1]
    snake = re.sub(r"(?<!^)(?=[A-Z])", "_", name.replace("::", "_")).lower()
    for slug, model in sorted(candidates):
        if slug in (snake, snake + "s"):
            return model
    return sorted(candidates, key=lambda c: (-len(c[1].get("properties") or {}), c[0]))[0][1]


def main() -> int:
    print(f"Starting Canvas OpenAPI update from {DOC_BASE} ...")
    print("=" * 64)
    API_DIR.mkdir(parents=True, exist_ok=True)

    try:
        index = fetch_json(f"{DOC_BASE}/api-docs.json")
    except Exception as e:
        print(f"[FAIL] could not fetch resource listing: {type(e).__name__}: {e}")
        return 1

    resources: List[Tuple[str, str, str]] = []  # (slug, title, url)
    for entry in index.get("apis", []) or []:
        path = entry.get("path") or ""
        if not path:
            continue
        slug = slugify(path)
        if RESOURCE_FILTER and slug not in RESOURCE_FILTER:
            continue
        title = entry.get("description") or slug.replace("_", " ").title()
        resources.append((slug, title, f"{DOC_BASE}/{path.lstrip('/')}"))

    if not resources:
        print("[FAIL] resource listing was empty (or CANVAS_RESOURCES matched nothing).")
        return 1

    print(f"Found {len(resources)} resources; downloading...")

    docs: Dict[str, Dict[str, Any]] = {}
    failures: List[str] = []

    def _get(item: Tuple[str, str, str]) -> Tuple[str, Optional[Dict[str, Any]], str]:
        slug, _title, url = item
        try:
            return slug, fetch_json(url), ""
        except Exception as e:
            return slug, None, f"{type(e).__name__}: {e}"

    with ThreadPoolExecutor(max_workers=max(1, CONCURRENCY)) as pool:
        for slug, doc, err in pool.map(_get, resources):
            if doc is None:
                failures.append(slug)
                print(f"[FAIL] {slug}: {err}")
            else:
                docs[slug] = doc

    if not docs:
        print("[FAIL] no resource documents downloaded.")
        return 1

    # Global model index: name -> [(owning slug, raw model), ...]
    model_index: Dict[str, List[Tuple[str, Dict[str, Any]]]] = {}
    for slug, doc in docs.items():
        for name, model in (doc.get("models") or {}).items():
            model_index.setdefault(name, []).append((slug, model))
    known_models = set(model_index)
    ambiguous = sum(1 for v in model_index.values() if len(v) > 1)
    print(f"Model index: {len(known_models)} models ({ambiguous} defined by more than one resource)")

    written = unchanged = 0
    for slug, title, _url in resources:
        doc = docs.get(slug)
        if doc is None:
            continue

        spec = convert_resource(slug, title, doc, known_models)

        # Local models win; foreign ones are copied in until every $ref resolves.
        schemas: Dict[str, Any] = {
            name: convert_model(model, known_models)
            for name, model in (doc.get("models") or {}).items()
        }
        spec["components"]["schemas"] = schemas
        for _ in range(10):
            wanted: Set[str] = set()
            collect_refs(spec, wanted)
            missing = {n for n in wanted if n not in schemas and n in model_index}
            if not missing:
                break
            for name in missing:
                schemas[name] = convert_model(pick_model_owner(name, model_index[name]), known_models)

        out_path = API_DIR / f"{slug}-openapi.json"
        old = _read_json_file(out_path)
        if old is not None and _canonical(old) == _canonical(spec):
            unchanged += 1
            continue
        _atomic_write_json(out_path, spec)
        written += 1

    print("=" * 64)
    ops = sum(
        1
        for slug in docs
        for a in docs[slug].get("apis", []) or []
        for _ in a.get("operations", []) or []
    )
    print(f"Converted {len(docs)}/{len(resources)} resources, {ops} operations")
    print(f"Written: {written}, unchanged: {unchanged}, failed: {len(failures)}")
    if failures:
        print("Failed resources: " + ", ".join(sorted(failures)))
        return 1
    print("All Canvas OpenAPI files are up to date.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""API key file parsing and provider key resolution.

Label aliases are loaded from api_keys_schema.json (shared with the frontend).
"""
import json
import os

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
API_KEY_FILENAMES = ["API Keys.txt", "API_Keys.txt", "api keys.txt", "api_keys.txt"]
GEMINI_FALLBACK_KEY = ""
_SCHEMA_PATH = os.path.join(APP_DIR, "api_keys_schema.json")
_ALIASES = None


def load_api_key_aliases(path=None):
    """Load (or reload) the shared alias map from api_keys_schema.json."""
    global _ALIASES
    schema_path = path or _SCHEMA_PATH
    with open(schema_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    aliases = data.get("aliases")
    if not isinstance(aliases, dict) or not aliases:
        raise ValueError('api_keys_schema.json is missing a non-empty "aliases" object.')
    _ALIASES = {str(k).strip().lower(): v for k, v in aliases.items()}
    return _ALIASES


def get_api_key_aliases():
    """Return the loaded alias map, loading from disk on first use."""
    global _ALIASES
    if _ALIASES is None:
        load_api_key_aliases()
    return dict(_ALIASES)


def parse_api_keys(text, aliases=None):
    """Parse API_Keys.txt-style text into a flat key map."""
    alias_map = aliases if aliases is not None else get_api_key_aliases()
    result = {}
    pending_key = None
    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        if ":" in line:
            label, value = line.split(":", 1)
            key = alias_map.get(label.strip().lower())
            value = value.strip()
            if key:
                if value:
                    result[key] = value
                    pending_key = None
                else:
                    pending_key = key
                continue
        if pending_key:
            result[pending_key] = line
            pending_key = None
    return result


def find_api_key_file():
    for filename in API_KEY_FILENAMES:
        path = os.path.join(APP_DIR, filename)
        if os.path.isfile(path):
            try:
                with open(path, "r", encoding="utf-8-sig") as f:
                    return filename, parse_api_keys(f.read())
            except OSError:
                return filename, {}
    return None, {}


def _api_key(name, override=None):
    value = str(override or "").strip()
    if not value:
        _, keys = find_api_key_file()
        value = str(keys.get(name) or "").strip()
    if name == "gemini" and (not value or value.startswith("YOUR_") or value.startswith("REPLACE---ME")):
        value = str(GEMINI_FALLBACK_KEY or "").strip()
    return value

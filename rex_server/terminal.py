"""Terminal command safety and shell abstraction."""
import asyncio
import json
import os
import re
import shutil
import subprocess
from functools import lru_cache
from pathlib import Path

_BLOCKLIST_PATH = Path(__file__).resolve().parent.parent / "terminal_blocklist.json"

# Fallback if the JSON file is missing (keep in sync with terminal_blocklist.json).
_FALLBACK_BLOCKED = [
    r"\bformat(?:\.com)?\s+[a-z]:",
    r"\brm\s+-rf\s+/(?:\s|$)",
    r"\bdel\s+/f\s+/s\s+/q\s+(?:[a-z]:\\|\\\\\?\\)",
    r"\breg(?:\.exe)?\s+delete\s+hk(?:local_machine|lm)(?:\\|\s|$)",
    r"\bbcdedit(?:\.exe)?\b",
    r"\bdiskpart(?:\.exe)?\b",
    r"\b(clear-disk|format-volume|initialize-disk)\b",
]


@lru_cache(maxsize=1)
def load_blocked_patterns():
    """Load blocked regex patterns from the shared JSON file."""
    try:
        data = json.loads(_BLOCKLIST_PATH.read_text(encoding="utf-8"))
        patterns = data.get("blocked_patterns") or []
        compiled = [re.compile(p, re.I) for p in patterns if p]
        if compiled:
            return tuple(compiled)
    except Exception as exc:
        print(f"[terminal] Could not load {_BLOCKLIST_PATH}: {exc}; using fallback blocklist")
    return tuple(re.compile(p, re.I) for p in _FALLBACK_BLOCKED)


def is_blocked_command(command):
    """Reject commands with unusually destructive system-wide effects."""
    text = str(command or "")
    return any(pattern.search(text) for pattern in load_blocked_patterns())


def get_shell():
    """
    Resolve the preferred interactive shell for this OS.

    Returns:
        (shell_path, shell_kind) where shell_kind is 'powershell' or 'posix'.
        shell_path may be None if nothing suitable is on PATH.
    """
    if os.name == "nt":
        shell = shutil.which("pwsh") or shutil.which("powershell")
        return shell, "powershell"
    shell = shutil.which("bash") or shutil.which("sh") or "/bin/sh"
    return shell, "posix"


def build_shell_argv(command, shell_path=None, shell_kind=None):
    """Build the subprocess argv list for running `command` in the resolved shell."""
    if shell_path is None or shell_kind is None:
        shell_path, shell_kind = get_shell()
    if not shell_path:
        return None, shell_kind
    if shell_kind == "powershell":
        return [
            shell_path,
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            command,
        ], shell_kind
    return [shell_path, "-lc", command], shell_kind


async def execute_terminal(command, workspace_getter=None):
    """Run an approved terminal command in the selected workspace."""
    from .workspace import get_workspace

    command = str(command or "").strip()
    if not command:
        return {"error": "No command provided."}
    if is_blocked_command(command):
        return {
            "error": "Command blocked: potentially destructive system command.",
            "blocked": True,
            "returncode": -1,
        }

    cwd = (workspace_getter or get_workspace)()
    args, shell_kind = build_shell_argv(command)
    if not args:
        if shell_kind == "powershell":
            return {
                "error": "PowerShell 7 or Windows PowerShell was not found on PATH.",
                "returncode": -1,
            }
        return {"error": "No suitable shell (bash/sh) was found on PATH.", "returncode": -1}

    shell_name = os.path.basename(args[0])
    print(f"[EXECUTING via {shell_name} ({shell_kind}) in {cwd}]: {command}")
    try:
        process = await asyncio.to_thread(
            subprocess.Popen,
            args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        stdout, stderr = await asyncio.to_thread(process.communicate, timeout=120)
        return {
            "stdout": stdout,
            "stderr": stderr,
            "returncode": process.returncode,
            "workspace": cwd,
            "shell": shell_name,
            "shell_kind": shell_kind,
        }
    except subprocess.TimeoutExpired:
        process.kill()
        await asyncio.to_thread(process.communicate)
        return {"error": "Command timed out after 120 seconds.", "returncode": -1}
    except Exception as exc:
        return {"error": str(exc)}

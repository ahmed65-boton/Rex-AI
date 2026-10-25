"""Workspace selection and safe workspace file operations."""
import os
import threading

DEFAULT_WORKSPACE_DIR = os.environ.get("REX_WORKSPACE", os.path.abspath(os.getcwd()))
WORKSPACE_DIR = DEFAULT_WORKSPACE_DIR
WORKSPACE_LOCK = threading.Lock()


def get_workspace():
    with WORKSPACE_LOCK:
        return WORKSPACE_DIR


def _windows_drives():
    if os.name != "nt":
        return [os.path.abspath(os.sep)]
    drives = []
    for code in range(ord("A"), ord("Z") + 1):
        drive = f"{chr(code)}:\\"
        if os.path.isdir(drive):
            drives.append(drive)
    return drives


def _normalize_browse_path(path):
    raw = str(path or "").strip()
    if os.name == "nt" and not raw:
        return None
    if os.name != "nt" and not raw:
        return os.path.abspath(os.sep)
    candidate = os.path.abspath(os.path.expanduser(raw))
    if not os.path.isdir(candidate):
        raise FileNotFoundError("Folder not found.")
    return candidate


def browse_workspace(path=""):
    current = _normalize_browse_path(path)
    if current is None:
        entries = []
        for drive in _windows_drives():
            entries.append({"name": drive.rstrip("\\/"), "path": drive, "type": "drive"})
        return {"ok": True, "path": "", "name": "This PC", "parent": None, "entries": entries}

    entries = []
    try:
        children = list(os.scandir(current))
    except OSError as exc:
        raise RuntimeError(f"Could not read folder: {exc}") from exc
    for item in children:
        try:
            if item.is_dir(follow_symlinks=False):
                entries.append({"name": item.name, "path": item.path, "type": "folder"})
        except OSError:
            continue
    entries.sort(key=lambda item: item["name"].lower())
    parent = os.path.dirname(current)
    if os.name == "nt" and os.path.splitdrive(current)[1] in ("\\", "/"):
        parent = ""
    elif parent == current:
        parent = ""
    return {
        "ok": True,
        "path": current,
        "name": os.path.basename(current.rstrip(os.sep)) or current,
        "parent": parent,
        "entries": entries,
    }


def select_workspace(path):
    global WORKSPACE_DIR
    candidate = _normalize_browse_path(path)
    if candidate is None:
        raise ValueError("Select a folder first.")
    with WORKSPACE_LOCK:
        WORKSPACE_DIR = candidate
    return get_workspace()


def create_workspace_folder(parent_path, name):
    parent = _normalize_browse_path(parent_path)
    if parent is None:
        raise ValueError("Open a drive or folder before creating a folder.")

    folder_name = str(name or "").strip()
    if not folder_name:
        raise ValueError("Folder name is required.")
    if folder_name in {".", ".."} or any(ch in folder_name for ch in '<>:\"/\\|?*'):
        raise ValueError("That is not a valid folder name.")
    if folder_name.endswith((".", " ")):
        raise ValueError("Folder names cannot end with a dot or space on Windows.")

    candidate = os.path.abspath(os.path.join(parent, folder_name))
    if os.path.commonpath([parent, candidate]) != parent:
        raise PermissionError("Folder path escapes the current picker location.")
    try:
        os.mkdir(candidate)
    except FileExistsError:
        raise FileExistsError(f'A folder named "{folder_name}" already exists.')
    except OSError as exc:
        raise RuntimeError(f"Could not create folder: {exc}") from exc
    return {"ok": True, "path": candidate, "name": folder_name, "type": "folder"}


def safe_workspace_path(relative_path, workspace_getter=None):
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise ValueError("A workspace-relative path is required.")

    root = os.path.abspath((workspace_getter or get_workspace)())
    candidate = os.path.abspath(os.path.join(root, relative_path.replace("/", os.sep)))
    if os.path.commonpath([root, candidate]) != root:
        raise PermissionError("Path escapes the selected workspace.")
    return candidate


def read_workspace_file(relative_path):
    path = safe_workspace_path(relative_path)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def write_workspace_file(relative_path, content):
    path = safe_workspace_path(relative_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(content)


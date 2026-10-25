// Command-risk classification shared by the chat tool approval UI.
// Absolute-block patterns come from terminal_blocklist.json (same file Python uses).

const FALLBACK_BLOCKED = [
  /\bformat(?:\.com)?\s+[a-z]:/i,
  /\brm\s+-rf\s+\/(?:\s|$)/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+(?:[a-z]:\\|\\\\\?\\)/i,
  /\breg(?:\.exe)?\s+delete\s+hk(?:local_machine|lm)(?:\\|\s|$)/i,
  /\bbcdedit(?:\.exe)?\b/i,
  /\bdiskpart(?:\.exe)?\b/i,
  /\b(clear-disk|format-volume|initialize-disk)\b/i,
];

let blockedPatterns = FALLBACK_BLOCKED.slice();
let blocklistLoaded = false;

function compileBlockedPatterns(patternStrings) {
  const compiled = [];
  for (const source of patternStrings || []) {
    try {
      compiled.push(new RegExp(source, 'i'));
    } catch (err) {
      console.warn('Invalid blocklist pattern skipped:', source, err);
    }
  }
  return compiled.length ? compiled : FALLBACK_BLOCKED.slice();
}

/** Load shared terminal_blocklist.json (browser fetch or Node fs). Safe to call multiple times. */
export async function loadTerminalBlocklist(urlOrPath = 'terminal_blocklist.json') {
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const { dirname, resolve } = await import('node:path');
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
      const text = await readFile(resolve(root, urlOrPath), 'utf8');
      const data = JSON.parse(text);
      blockedPatterns = compileBlockedPatterns(data.blocked_patterns);
    } else {
      const res = await fetch(urlOrPath, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      blockedPatterns = compileBlockedPatterns(data.blocked_patterns);
    }
    blocklistLoaded = true;
  } catch (err) {
    console.warn('Could not load terminal_blocklist.json; using built-in fallback.', err);
    blockedPatterns = FALLBACK_BLOCKED.slice();
  }
  return blockedPatterns;
}

export function getBlockedPatterns() {
  return blockedPatterns.slice();
}

export function isBlockedCommand(cmd) {
  const c = String(cmd || '');
  return blockedPatterns.some(pattern => pattern.test(c));
}

export function assessRisk(cmd) {
  const c = String(cmd || '').toLowerCase().trim();
  if (isBlockedCommand(c) || blockedPatterns.some(pattern => pattern.test(String(cmd || '')))) {
    return {
      level: 'blocked',
      label: 'BLOCKED',
      title: 'Blocked destructive command',
      assessment: 'Rex refuses to run this command because it can destroy data or damage system configuration.',
    };
  }

  // HIGH risk patterns (approval + type-to-confirm in UI; not absolute server block)
  const highPatterns = [
    /rmdir\s+\/s/i, /del\s+\/f\s+\/s/i, /del\s+\/s/i, /rm\s+-rf/i,
    /format\s+[a-z]:/i, /diskpart/i, /reg\s+delete/i, /reg\s+add/i,
    /netsh/i, /sc\s+(delete|create|stop|start)/i, /taskkill\s+\/f/i,
    /icacls/i, /cacls/i, /takeown/i, /bcdedit/i, /pip\s+install\s+--user/i,
    /shutdown/i, /powercfg/i, /sfc\s+\/scannow/i,
    /remove-item.*-recurse/i, /remove-item.*-force/i, /stop-computer/i, /restart-computer/i,
    /clear-disk/i, /format-volume/i, /initialize-disk/i, /set-disk/i, /set-partition/i,
  ];
  if (highPatterns.some(p => p.test(c))) {
    return {
      level: 'high',
      label: 'HIGH',
      title: 'Destructive / System-Level Command',
      assessment: 'This command may cause irreversible structural changes, recursive deletions, or system-level modifications. Review the full impact before approving.',
    };
  }

  // MEDIUM risk patterns
  const mediumPatterns = [
    /del\s+/i, /erase\s+/i, /rm\s+/i, /move\s+/i, /mv\s+/i,
    /git\s+checkout\s+\./i, /git\s+reset/i, /git\s+clean/i,
    /xcopy/i, /robocopy/i, /copy\s+.*\/y/i, /attrib/i,
    /rename\s+/i, /ren\s+/i, /remove-item/i, /move-item/i, /copy-item.*-force/i,
  ];
  if (mediumPatterns.some(p => p.test(c))) {
    return {
      level: 'medium',
      label: 'MEDIUM',
      title: 'File Modification / Non-Recursive Deletion',
      assessment: 'This command will modify or delete specific files. Targeted paths will be affected. Confirm the exact files listed above before approving.',
    };
  }

  return {
    level: 'low',
    label: 'LOW',
    title: 'Non-Destructive Operation',
    assessment: 'This command is read-only, installs a package to the active virtual environment, or otherwise has limited lasting impact.',
  };
}

/* Terminal risk cards (including high-risk type-to-confirm). */
import { assessRisk } from './command-risk.js';
import { sendCommand } from './ws.js';

let runtime = {};
export function configureRisk(options) { runtime = options; }

export function commandConfirmToken(command) {
  // First shell token (command name), e.g. "rm -rf ./x" → "rm"
  const raw = String(command || '').trim();
  if (!raw) return '';
  const match = raw.match(/^([^\s]+)/);
  return match ? match[1] : raw;
}

export function renderRiskCard(command, risk) {
  return new Promise(resolve => {
    const id = 'risk-' + Date.now();
    const card = document.createElement('div');
    card.className = `risk-card ${risk.level}`;
    card.id = id;

    const isBlocked = risk.level === 'blocked';
    const needsTypeConfirm = risk.level === 'high';
    const confirmToken = commandConfirmToken(command);

    let actionsHtml;
    if (isBlocked) {
      actionsHtml = `
        <div class="risk-blocked-note">Execution refused. This command cannot be run.</div>
        <div class="risk-actions">
          <button class="btn-deny" type="button">Dismiss</button>
        </div>`;
    } else if (needsTypeConfirm) {
      actionsHtml = `
        <label class="risk-confirm-label" for="${id}-confirm">
          Type <code>${runtime.escHtml(confirmToken)}</code> to enable Execute
        </label>
        <input class="risk-confirm-input field-input" id="${id}-confirm" type="text"
          autocomplete="off" spellcheck="false" placeholder="${runtime.escHtml(confirmToken)}" aria-label="Type command name to confirm">
        <div class="risk-actions">
          <button class="btn-approve" type="button" disabled>Execute</button>
          <button class="btn-deny" type="button">Deny</button>
        </div>`;
    } else {
      actionsHtml = `
        <div class="risk-actions">
          <button class="btn-approve" type="button">Execute</button>
          <button class="btn-deny" type="button">Deny</button>
        </div>`;
    }

    card.innerHTML = `
      <div class="risk-header">
        <span class="risk-badge">${risk.label}</span>
        <span class="risk-title">${risk.title}</span>
      </div>
      <div class="risk-cmd">${runtime.escHtml(command)}</div>
      <div class="risk-assessment">${risk.assessment}</div>
      ${actionsHtml}
    `;

    const bubble = runtime.appendAgentBubble();
    bubble.appendChild(card);
    runtime.scrollBottom();
    runtime.setStatus('waiting', isBlocked ? 'Command blocked' : 'Awaiting Terminal Approval');

    const approveButton = card.querySelector('.btn-approve');
    const denyButton = card.querySelector('.btn-deny');
    const confirmInput = card.querySelector('.risk-confirm-input');
    let decided = false;

    function lockDecision(label) {
      decided = true;
      if (approveButton) {
        approveButton.disabled = true;
        approveButton.setAttribute('aria-disabled', 'true');
        if (label) approveButton.textContent = label;
      }
      if (denyButton) {
        denyButton.disabled = true;
        denyButton.setAttribute('aria-disabled', 'true');
      }
      if (confirmInput) {
        confirmInput.disabled = true;
      }
      card.classList.add('decision-locked');
    }

    if (confirmInput && approveButton) {
      const syncApprove = () => {
        const typed = confirmInput.value.trim();
        // Accept exact command name (first token) or the full command string.
        const ok = typed === confirmToken || typed === String(command).trim();
        approveButton.disabled = !ok;
      };
      confirmInput.addEventListener('input', syncApprove);
      confirmInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !approveButton.disabled) {
          e.preventDefault();
          approveButton.click();
        }
      });
      syncApprove();
      setTimeout(() => confirmInput.focus(), 0);
    }

    async function runApproved() {
      if (decided || !approveButton) return;
      if (needsTypeConfirm && confirmInput) {
        const typed = confirmInput.value.trim();
        if (typed !== confirmToken && typed !== String(command).trim()) {
          confirmInput.classList.add('risk-confirm-mismatch');
          return;
        }
      }
      lockDecision('Executing…');
      card.classList.add('executed');
      runtime.setStatus('active', 'Executing command…');
      try {
        const result = await sendCommand(command);
        if (result?.blocked) {
          const resultDiv = document.createElement('div');
          resultDiv.className = 'risk-result';
          resultDiv.textContent = result.error || 'Command blocked by the server.';
          card.appendChild(resultDiv);
          runtime.setStatus('idle', 'Command blocked');
          resolve({ approved: false, blocked: true, error: result.error });
        } else {
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || '(no output)';
          const resultDiv = document.createElement('div');
          resultDiv.className = 'risk-result';
          resultDiv.textContent = `$ ${command}\n${output}\n\nexitcode: ${result.returncode}`;
          card.appendChild(resultDiv);
          runtime.setStatus('idle', 'Command completed');
          resolve({ approved: true, output });
        }
      } catch (err) {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'risk-result';
        resultDiv.textContent = `Error: ${err.message}`;
        card.appendChild(resultDiv);
        runtime.setStatus('error', 'Command failed');
        resolve({ approved: true, error: err.message });
      }
      runtime.scrollBottom();
    }

    approveButton?.addEventListener('click', () => { runApproved(); });

    denyButton?.addEventListener('click', () => {
      if (decided) return;
      lockDecision(approveButton ? 'Execute' : undefined);
      card.classList.add('denied');
      const resultDiv = document.createElement('div');
      resultDiv.className = 'risk-result';
      resultDiv.textContent = isBlocked ? 'Blocked command dismissed.' : 'Command denied by user.';
      card.appendChild(resultDiv);
      runtime.setStatus('idle', isBlocked ? 'Command blocked' : 'Command denied');
      resolve({ approved: false, blocked: isBlocked });
      runtime.scrollBottom();
    });

    if (isBlocked) {
      card.classList.add('blocked');
    }
  });
}

/* ── Tool Dispatcher (called from AI response parsing) ─────── */

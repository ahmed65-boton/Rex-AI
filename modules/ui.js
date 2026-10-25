/* Shared custom dialog primitives for Rex UI. */
function openRexDialog(title, description = '') {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop open';
  backdrop.style.zIndex = '80';
  backdrop.setAttribute('role', 'dialog');
  backdrop.setAttribute('aria-modal', 'true');
  backdrop.setAttribute('aria-label', title);
  const modal = document.createElement('section');
  modal.className = 'modal rex-dialog';
  const header = document.createElement('div');
  header.className = 'modal-header';
  const heading = document.createElement('span');
  heading.textContent = title;
  const closeButton = document.createElement('button');
  closeButton.className = 'modal-close';
  closeButton.type = 'button';
  closeButton.setAttribute('aria-label', 'Close');
  closeButton.textContent = '✕';
  header.append(heading, closeButton);
  const body = document.createElement('div');
  body.className = 'rex-dialog-body';
  if (description) {
    const intro = document.createElement('p');
    intro.className = 'rex-dialog-description';
    intro.textContent = description;
    body.appendChild(intro);
  }
  const footer = document.createElement('div');
  footer.className = 'rex-dialog-footer';
  modal.append(header, body, footer);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  let settled = false;
  let resolvePromise;
  const promise = new Promise(resolve => { resolvePromise = resolve; });
  const close = value => {
    if (settled) return;
    settled = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
    resolvePromise(value);
  };
  const onKeyDown = event => { if (event.key === 'Escape') close(null); };
  closeButton.addEventListener('click', () => close(null));
  backdrop.addEventListener('click', event => { if (event.target === backdrop) close(null); });
  document.addEventListener('keydown', onKeyDown);
  return { body, footer, promise, close };
}

function addDialogButton(dialog, label, value, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'btn-primary' : 'btn-ghost';
  button.textContent = label;
  button.addEventListener('click', () => dialog.close(value));
  dialog.footer.appendChild(button);
  return button;
}

async function showTextEntryModal(title, description, placeholder, submitLabel, initialValue = '') {
  const dialog = openRexDialog(title, description);
  const input = document.createElement('input');
  input.className = 'field-input rex-dialog-input';
  input.type = 'text';
  input.placeholder = placeholder;
  input.autocomplete = 'off';
  if (initialValue) input.value = initialValue;
  dialog.body.appendChild(input);
  addDialogButton(dialog, 'Cancel', null);
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn-primary';
  submit.textContent = submitLabel;
  submit.addEventListener('click', () => {
    if (!input.value.trim()) {
      input.setCustomValidity('Enter a name first.');
      input.reportValidity();
      return;
    }
    dialog.close(input.value);
  });
  dialog.footer.appendChild(submit);
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') submit.click();
  });
  requestAnimationFrame(() => input.focus());
  return dialog.promise;
}


export { openRexDialog, addDialogButton, showTextEntryModal };

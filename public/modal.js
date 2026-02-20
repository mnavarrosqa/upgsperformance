(function () {
  var modal = document.getElementById('app-modal');
  if (!modal) return;

  var titleEl = document.getElementById('app-modal-title');
  var messageEl = document.getElementById('app-modal-desc');
  var actionsEl = document.getElementById('app-modal-actions');
  var backdrop = modal.querySelector('.app-modal__backdrop');

  var resolvePromise = null;
  var isConfirm = false;
  var isChoice = false;

  function close(result) {
    modal.setAttribute('hidden', '');
    if (resolvePromise) {
      resolvePromise(result);
      resolvePromise = null;
    }
    document.removeEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (isConfirm) close(false);
    else close(null);
  }

  function clearActions() {
    if (!actionsEl) return;
    actionsEl.innerHTML = '';
  }

  function addButton(label, className, value, clickValue) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'app-modal__btn ' + (className || 'app-modal__btn--primary');
    btn.textContent = label;
    btn.addEventListener('click', function () {
      close(clickValue !== undefined ? clickValue : value);
    });
    actionsEl.appendChild(btn);
    return btn;
  }

  function show(message, config) {
    config = config || {};
    var title = config.title != null ? config.title : 'Confirm';
    var okLabel = config.okLabel != null ? config.okLabel : 'OK';
    var cancelLabel = config.cancelLabel != null ? config.cancelLabel : 'Cancel';
    var danger = Boolean(config.danger);
    isConfirm = config.mode === 'confirm';

    titleEl.textContent = title;
    messageEl.textContent = message;
    clearActions();

    if (config.mode === 'choice' && Array.isArray(config.choices)) {
      isChoice = true;
      isConfirm = false;
      config.choices.forEach(function (opt) {
        addButton(opt.label, opt.primary ? 'app-modal__btn--primary' : 'app-modal__btn--secondary', null, opt.value);
      });
      addButton(cancelLabel, 'app-modal__btn--secondary', null, null);
      modal.removeAttribute('hidden');
      document.addEventListener('keydown', onKeydown);
      var firstChoice = actionsEl.querySelector('.app-modal__btn');
      if (firstChoice) firstChoice.focus();
      return;
    }
    isChoice = false;

    if (isConfirm) {
      addButton(cancelLabel, 'app-modal__btn--secondary', null, false);
      addButton(okLabel, danger ? 'app-modal__btn--danger' : 'app-modal__btn--primary', null, true);
    } else {
      addButton(okLabel, 'app-modal__btn--primary', null, undefined);
    }

    modal.removeAttribute('hidden');
    document.addEventListener('keydown', onKeydown);
    var primaryBtn = actionsEl.querySelector('.app-modal__btn--primary, .app-modal__btn--danger');
    if (primaryBtn) primaryBtn.focus();
    else if (actionsEl.lastElementChild) actionsEl.lastElementChild.focus();
  }

  backdrop.addEventListener('click', function () {
    if (isConfirm) close(false);
    else close(null);
  });

  window.showAlert = function (message, title) {
    return new Promise(function (resolve) {
      resolvePromise = resolve;
      show(message, { mode: 'alert', title: title != null ? String(title) : '' });
    });
  };

  window.showConfirm = function (message, options) {
    return new Promise(function (resolve) {
      resolvePromise = resolve;
      show(message, Object.assign({ mode: 'confirm' }, options));
    });
  };

  window.showChoice = function (message, title, choices) {
    return new Promise(function (resolve) {
      resolvePromise = resolve;
      show(message, { mode: 'choice', title: title != null ? String(title) : 'Choose', choices: choices });
    });
  };
})();

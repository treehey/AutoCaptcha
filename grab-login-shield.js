// Bounded interaction shield for the course-system login panel.
(function initNjuGrabLoginShield(global) {
  'use strict';

  const STATUS = Object.freeze({
    PREPARING: 'preparing',
    LOADING: 'loading',
    SUCCESS: 'success',
    ERROR: 'error'
  });

  const DEFAULT_LEASE_MS = Object.freeze({
    [STATUS.PREPARING]: 3000,
    [STATUS.LOADING]: 12000,
    [STATUS.SUCCESS]: 8000,
    [STATUS.ERROR]: 1200
  });

  const ROOT_ATTRIBUTE = 'data-nju-ai-status';
  const MESSAGE_PROPERTY = '--nju-ai-msg';
  const STYLE_ID = 'nju-grab-ai-overlay-style';

  const STYLE_TEXT = `
    html[${ROOT_ATTRIBUTE}] #loginDiv {
      position: relative !important;
      pointer-events: none !important;
    }

    html[${ROOT_ATTRIBUTE}] #loginDiv::before {
      content: "";
      position: absolute;
      inset: -20px -28px;
      z-index: 9998;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 18px;
      background: rgba(18, 18, 24, 0.5);
      box-shadow: inset 0 1px rgba(255, 255, 255, 0.08), 0 18px 48px rgba(0, 0, 0, 0.3);
      backdrop-filter: blur(18px) saturate(125%);
      -webkit-backdrop-filter: blur(18px) saturate(125%);
    }

    html[${ROOT_ATTRIBUTE}] #loginDiv::after {
      content: var(${MESSAGE_PROPERTY}, "正在准备自动登录…");
      position: absolute;
      inset: 0;
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #f5f5f7;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-shadow: 0 1px 12px rgba(0, 0, 0, 0.35);
      animation: nju-login-shield-breathe 1.6s ease-in-out infinite;
    }

    html[${ROOT_ATTRIBUTE}="${STATUS.SUCCESS}"] #loginDiv::before {
      border-color: rgba(52, 199, 89, 0.3);
      box-shadow: inset 0 0 30px rgba(52, 199, 89, 0.13), 0 18px 48px rgba(0, 0, 0, 0.3);
    }

    html[${ROOT_ATTRIBUTE}="${STATUS.SUCCESS}"] #loginDiv::after {
      color: #6fe18d;
      animation: none;
    }

    html[${ROOT_ATTRIBUTE}="${STATUS.ERROR}"] #loginDiv::before {
      border-color: rgba(255, 69, 58, 0.32);
      box-shadow: inset 0 0 30px rgba(255, 69, 58, 0.13), 0 18px 48px rgba(0, 0, 0, 0.3);
    }

    html[${ROOT_ATTRIBUTE}="${STATUS.ERROR}"] #loginDiv::after {
      color: #ff8a83;
      animation: none;
    }

    html[${ROOT_ATTRIBUTE}] #nju-click-captcha-solver-overlay,
    html[${ROOT_ATTRIBUTE}] #nju-click-captcha-capture-overlay {
      display: none !important;
    }

    @keyframes nju-login-shield-breathe {
      0%, 100% { opacity: 0.72; }
      50% { opacity: 1; }
    }

    @media (prefers-reduced-motion: reduce) {
      html[${ROOT_ATTRIBUTE}] #loginDiv::after {
        animation: none !important;
      }
    }
  `;

  function createLoginShield(options = {}) {
    const documentRef = options.documentRef || global.document;
    const setTimeoutFn = options.setTimeoutFn || global.setTimeout?.bind(global);
    const clearTimeoutFn = options.clearTimeoutFn || global.clearTimeout?.bind(global);
    const MutationObserverCtor = options.MutationObserverCtor || global.MutationObserver;
    const isAuthenticatedPage = typeof options.isAuthenticatedPage === 'function'
      ? options.isAuthenticatedPage
      : null;
    let leaseTimer = null;
    let pageObserver = null;

    function cancelLease() {
      if (leaseTimer !== null && clearTimeoutFn) clearTimeoutFn(leaseTimer);
      leaseTimer = null;
    }

    function cancelPageObserver() {
      pageObserver?.disconnect?.();
      pageObserver = null;
    }

    function authenticatedPageReached() {
      if (!isAuthenticatedPage) return false;
      try {
        return Boolean(isAuthenticatedPage());
      } catch {
        return false;
      }
    }

    function clear() {
      cancelLease();
      cancelPageObserver();
      const root = documentRef?.documentElement;
      if (!root) return;
      root.removeAttribute(ROOT_ATTRIBUTE);
      root.style?.removeProperty(MESSAGE_PROPERTY);
    }

    function watchAuthenticatedPage() {
      cancelPageObserver();
      if (!isAuthenticatedPage) return;
      if (authenticatedPageReached()) {
        clear();
        return;
      }
      const root = documentRef?.documentElement;
      if (!root || typeof MutationObserverCtor !== 'function') return;
      pageObserver = new MutationObserverCtor(() => {
        if (authenticatedPageReached()) clear();
      });
      pageObserver.observe(root, { childList: true, subtree: true, attributes: true });
    }

    function ensureStyle() {
      if (documentRef.getElementById(STYLE_ID)) return true;
      const parent = documentRef.head || documentRef.documentElement;
      if (!parent?.appendChild || !documentRef.createElement) return false;
      const style = documentRef.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE_TEXT;
      parent.appendChild(style);
      return true;
    }

    function show(status, message, showOptions = {}) {
      const root = documentRef?.documentElement;
      if (!root || !documentRef.getElementById('loginDiv') || !Object.values(STATUS).includes(status)) {
        clear();
        return false;
      }
      if (!ensureStyle()) return false;

      cancelLease();
      cancelPageObserver();
      root.setAttribute(ROOT_ATTRIBUTE, status);
      if (message) root.style?.setProperty(MESSAGE_PROPERTY, JSON.stringify(String(message)));
      else root.style?.removeProperty(MESSAGE_PROPERTY);

      watchAuthenticatedPage();
      if (!root.hasAttribute(ROOT_ATTRIBUTE)) return true;

      const requestedLease = Number(showOptions.leaseMs);
      const leaseMs = Number.isFinite(requestedLease) && requestedLease > 0
        ? requestedLease
        : DEFAULT_LEASE_MS[status];
      if (setTimeoutFn) leaseTimer = setTimeoutFn(clear, leaseMs);
      return true;
    }

    function resolveAutomation(enabled) {
      if (!enabled) clear();
      return Boolean(enabled);
    }

    function isActive() {
      return Boolean(documentRef?.documentElement?.hasAttribute(ROOT_ATTRIBUTE));
    }

    return Object.freeze({ clear, isActive, resolveAutomation, show });
  }

  const exported = Object.freeze({ createLoginShield, STATUS });
  global.NjuGrabLoginShield = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(typeof globalThis !== 'undefined' ? globalThis : self);

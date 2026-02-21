// ============================================================
// OceanCRM Extension — Content Script (ISOLATED World)
// ============================================================
// Role: API Gateway + Resource Injector + CustomEvent Bridge
//
// This script runs in Chrome's ISOLATED world. It does NOT render
// any UI (that's main-world.js's job). It:
//   1. Injects jQuery, CSS, and wa-inject.js into the page
//   2. Bridges CustomEvent requests from MAIN world to background.js
//   3. Provides loading overlay and toast notifications during init
// ============================================================

// ============================================================
// SECTION 1: WPP.JS INJECTION & EVENT BRIDGE
// ============================================================

/**
 * Inject wa-inject.js (WPP.js library) into the page context.
 * This runs in the ISOLATED world but injects a <script> into the page,
 * which executes in the MAIN world and registers window.WPP.
 *
 * Pattern taken from Kraya (ext-bundle.min.js lines 55-57):
 * createElement("script") → getURL("js/wa-inject.js") → onload remove → append to head
 */
function injectWPP() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("lib/wa-inject.js");
  script.onload = function () {
    this.remove(); // Clean up script tag after load
  };
  document.head.appendChild(script);
  console.log("[OceanCRM] Injected wa-inject.js into page");
}

/** @type {Map<string, {resolve: Function, reject: Function}>} */
const pendingWPPRequests = new Map();

/**
 * Send a request to the MAIN world script (main-world.js) via CustomEvent.
 * Returns a Promise that resolves when the MAIN world responds.
 *
 * @param {string} type - Request type (e.g., "getChatList", "findChat")
 * @param {object} payload - Request payload
 * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns {Promise<any>} - The result from WPP
 */
function wppRequest(type, payload, timeoutMs) {
  if (timeoutMs === undefined) timeoutMs = 10000;

  return new Promise(function (resolve, reject) {
    const id = crypto.randomUUID();

    // Set timeout to avoid hanging forever
    const timer = setTimeout(function () {
      pendingWPPRequests.delete(id);
      reject(new Error("WPP request timeout: " + type));
    }, timeoutMs);

    pendingWPPRequests.set(id, {
      resolve: function (result) {
        clearTimeout(timer);
        resolve(result);
      },
      reject: function (error) {
        clearTimeout(timer);
        reject(error);
      },
    });

    // Dispatch request to MAIN world
    window.dispatchEvent(
      new CustomEvent("ocean-request", {
        detail: { id: id, type: type, payload: payload || {} },
      }),
    );
  });
}

/**
 * Listen for responses from MAIN world.
 */
window.addEventListener("ocean-response", function (event) {
  const detail = event.detail;
  const pending = pendingWPPRequests.get(detail.id);
  if (!pending) return;

  pendingWPPRequests.delete(detail.id);

  if (detail.error) {
    pending.reject(new Error(detail.error));
  } else {
    pending.resolve(detail.result);
  }
});

/**
 * Wait for WPP to be ready (main-world.js signals via ocean-wpp-ready event).
 * @returns {Promise<void>}
 */
function waitForWPPReady() {
  return new Promise(function (resolve) {
    // Check if already ready
    wppRequest("isWPPReady", {}, 2000)
      .then(function (result) {
        if (result && result.ready) {
          console.log("[OceanCRM] WPP already ready");
          resolve();
          return;
        }
        // Not ready, wait for event
        waitForEvent();
      })
      .catch(function () {
        // Not ready, wait for event
        waitForEvent();
      });

    function waitForEvent() {
      window.addEventListener(
        "ocean-wpp-ready",
        function () {
          console.log("[OceanCRM] WPP ready (via event)");
          resolve();
        },
        { once: true },
      );
    }
  });
}

// ============================================================
// SECTION 2: RESOURCE INJECTION (jQuery + CSS)
// ============================================================

/**
 * Inject jQuery into the MAIN world via <script> tag.
 * After injection, window.jQuery and window.$ are available in MAIN world.
 *
 * Pattern: Kraya's r() function (ext-bundle.min.js)
 *
 * @returns {Promise<void>} Resolves when jQuery script has loaded.
 */
function injectJQuery() {
  return new Promise(function (resolve, reject) {
    // Check if already injected
    if (document.querySelector("script[data-ocrm-jquery]")) {
      console.log("[OceanCRM] jQuery already injected");
      resolve();
      return;
    }

    var script = document.createElement("script");
    script.src = chrome.runtime.getURL("lib/jquery.js");
    script.setAttribute("data-ocrm-jquery", "true");
    script.onload = function () {
      this.remove(); // Clean up script tag after execution
      console.log("[OceanCRM] jQuery injected into MAIN world");
      resolve();
    };
    script.onerror = function () {
      console.error("[OceanCRM] Failed to inject jQuery");
      reject(new Error("jQuery injection failed"));
    };
    (document.head || document.documentElement).appendChild(script);
  });
}

/**
 * CSS file paths to inject (relative to extension root).
 * Order matters — later files can override earlier ones.
 */
var CSS_FILES = ["src/styles.css", "src/navbar.css", "src/components.css"];

/**
 * Inject CSS files into the page via <link> tags.
 * Uses chrome.runtime.getURL() to get the extension URL for each file.
 *
 * Pattern: Kraya's l() function (ext-bundle.min.js)
 *
 * These become page-level stylesheets accessible from both ISOLATED
 * and MAIN worlds, unlike manifest-declared CSS which is ISOLATED only.
 */
function injectCSS() {
  CSS_FILES.forEach(function (path) {
    // Check if already injected
    var existingId = "ocrm-css-" + path.replace(/[/.]/g, "-");
    if (document.getElementById(existingId)) {
      return;
    }

    var link = document.createElement("link");
    link.id = existingId;
    link.rel = "stylesheet";
    link.type = "text/css";
    link.href = chrome.runtime.getURL(path);
    (document.head || document.documentElement).appendChild(link);
  });

  console.log("[OceanCRM] Injected " + CSS_FILES.length + " CSS files");
}

/**
 * Wait a random duration between minMs and maxMs milliseconds.
 * Used to introduce a delay before WPP injection to avoid detection.
 *
 * @param {number} minMs - Minimum delay (default: 5000)
 * @param {number} maxMs - Maximum delay (default: 10000)
 * @returns {Promise<void>}
 */
function randomDelay(minMs, maxMs) {
  if (minMs === undefined) minMs = 5000;
  if (maxMs === undefined) maxMs = 10000;
  var delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  console.log("[OceanCRM] Waiting " + delay + "ms before WPP injection...");
  return new Promise(function (resolve) {
    setTimeout(resolve, delay);
  });
}

// ============================================================
// SECTION 3: API BRIDGE
// ============================================================

/**
 * Set up the CustomEvent bridge between MAIN world scripts and background.js.
 *
 * MAIN world (main-world.js) dispatches OceanCRM*RequestEvent events.
 * This bridge receives them, forwards to background.js via chrome.runtime.sendMessage,
 * then dispatches OceanCRM*ResponseEvent back to MAIN world.
 *
 * Supported events:
 *   OceanCRMFetchLeadsRequestEvent  → type: "getLeads"
 *   OceanCRMGetStagesRequestEvent   → type: "getStages"
 *   OceanCRMGetOrgsRequestEvent     → type: "getOrgs"
 *   OceanCRMPingAuthRequestEvent    → type: "pingAuth"
 *   OceanCRMCreateLeadRequestEvent  → type: "createLead"
 */
function setupAPIBridge() {
  // ── Fetch Leads ──────────────────────────────────────────────
  window.addEventListener("OceanCRMFetchLeadsRequestEvent", function (event) {
    var detail = event.detail || {};
    sendMessage({
      type: "getLeads",
      baseUrl: detail.baseUrl,
      orgId: detail.orgId,
      page: detail.page,
      pageSize: detail.pageSize,
      since: detail.since,
    })
      .then(function (response) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMFetchLeadsResponseEvent", {
            detail: response,
          }),
        );
      })
      .catch(function (err) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMFetchLeadsResponseEvent", {
            detail: { ok: false, error: err.message },
          }),
        );
      });
  });

  // ── Get Stages ───────────────────────────────────────────────
  window.addEventListener("OceanCRMGetStagesRequestEvent", function (event) {
    var detail = event.detail || {};
    sendMessage({
      type: "getStages",
      baseUrl: detail.baseUrl,
      orgId: detail.orgId,
    })
      .then(function (response) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMGetStagesResponseEvent", {
            detail: response,
          }),
        );
      })
      .catch(function (err) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMGetStagesResponseEvent", {
            detail: { ok: false, error: err.message },
          }),
        );
      });
  });

  // ── Get Organizations ────────────────────────────────────────
  window.addEventListener("OceanCRMGetOrgsRequestEvent", function (event) {
    var detail = event.detail || {};
    sendMessage({
      type: "getOrgs",
      baseUrl: detail.baseUrl,
    })
      .then(function (response) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMGetOrgsResponseEvent", {
            detail: response,
          }),
        );
      })
      .catch(function (err) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMGetOrgsResponseEvent", {
            detail: { ok: false, error: err.message },
          }),
        );
      });
  });

  // ── Ping Auth ────────────────────────────────────────────────
  window.addEventListener("OceanCRMPingAuthRequestEvent", function (event) {
    var detail = event.detail || {};
    sendMessage({
      type: "pingAuth",
      baseUrl: detail.baseUrl,
    })
      .then(function (response) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMPingAuthResponseEvent", {
            detail: response,
          }),
        );
      })
      .catch(function (err) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMPingAuthResponseEvent", {
            detail: { ok: false, error: err.message },
          }),
        );
      });
  });

  // ── Create Lead ──────────────────────────────────────────────
  window.addEventListener("OceanCRMCreateLeadRequestEvent", function (event) {
    var detail = event.detail || {};
    sendMessage({
      type: "createLead",
      baseUrl: detail.baseUrl,
      orgId: detail.orgId,
      lead: detail.lead,
    })
      .then(function (response) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMCreateLeadResponseEvent", {
            detail: response,
          }),
        );
      })
      .catch(function (err) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMCreateLeadResponseEvent", {
            detail: { ok: false, error: err.message },
          }),
        );
      });
  });

  // ── Update Lead ──────────────────────────────────────────────
  window.addEventListener("OceanCRMUpdateLeadRequestEvent", function (event) {
    var detail = event.detail || {};
    sendMessage({
      type: "updateLead",
      baseUrl: detail.baseUrl,
      orgId: detail.orgId,
      leadId: detail.leadId,
      lead: detail.lead,
    })
      .then(function (response) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMUpdateLeadResponseEvent", {
            detail: response,
          }),
        );
      })
      .catch(function (err) {
        window.dispatchEvent(
          new CustomEvent("OceanCRMUpdateLeadResponseEvent", {
            detail: { ok: false, error: err.message },
          }),
        );
      });
  });

  // ── Broadcast Base URL to MAIN world ──
  loadBaseUrl().then(function (url) {
    window.dispatchEvent(
      new CustomEvent("OceanCRMConfigEvent", {
        detail: { baseUrl: url || DEFAULT_BASE_URL },
      }),
    );
  });

  console.log("[OceanCRM] API bridge ready (6 event handlers registered)");
}

// ============================================================
// SECTION 4: UTILITIES
// ============================================================

const DEFAULT_BASE_URL = "http://localhost:8000/api";

// ============ LOADING MESSAGES ============
const LOADING_MESSAGES = [
  "Initializing OceanCRM...",
  "Connecting to WhatsApp...",
  "Setting up lead management...",
  "Preparing sidebar...",
  "Loading CRM features...",
  "Almost ready...",
];

/**
 * Send a message to background.js and return a Promise.
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Wait for one of the given CSS selectors to appear in the DOM.
 * Uses MutationObserver for efficiency.
 *
 * @param {string[]} selectors
 * @param {number} timeout - milliseconds (default: 30000)
 * @returns {Promise<Element>}
 */
function waitForElements(selectors, timeout = 30000) {
  return new Promise((resolve, reject) => {
    // Check if any element exists immediately
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
    }

    // Set up observer to watch for elements
    const observer = new MutationObserver(() => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el) {
          observer.disconnect();
          clearTimeout(timeoutId);
          resolve(el);
          return;
        }
      }
    });

    observer.observe(document.body, { subtree: true, childList: true });

    // Timeout fallback
    const timeoutId = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timeout waiting for WhatsApp elements"));
    }, timeout);
  });
}

// ============ LOADING OVERLAY ============

function showLoadingOverlay(message = "Initializing OceanCRM...") {
  if (document.getElementById("ocrm-loading-overlay")) {
    updateLoadingMessage(message);
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "ocrm-loading-overlay";
  overlay.innerHTML = `
    <div class="ocrm-loader-content">
      <div class="ocrm-loader-spinner">
        <div></div><div></div><div></div><div></div>
      </div>
      <div id="ocrm-loader-text">${message}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function updateLoadingMessage(message) {
  const textEl = document.getElementById("ocrm-loader-text");
  if (textEl) textEl.textContent = message;
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("ocrm-loading-overlay");
  if (overlay) {
    overlay.classList.add("fade-out");
    setTimeout(() => overlay.remove(), 300);
  }
}

function cycleLoadingMessages(duration = 5000) {
  let index = 0;
  const interval = Math.ceil(duration / LOADING_MESSAGES.length);
  const timer = setInterval(() => {
    if (index < LOADING_MESSAGES.length) {
      updateLoadingMessage(LOADING_MESSAGES[index]);
      index++;
    } else {
      clearInterval(timer);
    }
  }, interval);
  return timer;
}

// ============ TOAST NOTIFICATIONS ============

/**
 * Show a toast notification.
 * @param {string} message
 * @param {"success"|"error"|"warning"|"info"} type
 * @param {number} duration - milliseconds (default: 3000)
 */
function showToast(message, type = "success", duration = 3000) {
  const existing = document.getElementById("ocrm-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.id = "ocrm-toast";
  toast.className = `ocrm-toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("fade-out");
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/**
 * Load the saved API base URL from chrome.storage.
 * Falls back to DEFAULT_BASE_URL if not set.
 * @returns {Promise<string>}
 */
async function loadBaseUrl() {
  const data = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL });
  return data.baseUrl || DEFAULT_BASE_URL;
}

// ============================================================
// SECTION 5: INITIALIZATION
// ============================================================

/**
 * Main initialization sequence.
 *
 * Steps:
 *   1. Show loading overlay
 *   2. Wait for WhatsApp DOM to be ready
 *   3. Inject jQuery into MAIN world
 *   4. Inject CSS files
 *   5. Random delay (5-10s) before WPP injection (stealth)
 *   6. Inject WPP.js (wa-inject.js)
 *   7. Set up API bridge
 *   8. Hide loading overlay
 */
async function initializeExtension() {
  console.log("[OceanCRM] Starting initialization...");

  try {
    // Step 1: Show loading overlay with cycling messages
    showLoadingOverlay("Initializing OceanCRM...");
    const messageTimer = cycleLoadingMessages(5000);

    // Step 2: Wait for WhatsApp to load
    await waitForElements(
      [
        '[title="Unread chats filter"]',
        '[title="Chat filters menu"]',
        "#side",
        "#app > div > div > div",
      ],
      30000,
    );

    updateLoadingMessage("Loading CRM features...");

    // Step 3: Inject jQuery into MAIN world (awaitable — main-world.js needs $)
    await injectJQuery();

    // Step 4: Inject CSS files (non-blocking <link> tags)
    injectCSS();

    // Step 5: Random delay before WPP injection
    await randomDelay(5000, 10000);

    // Step 6: Inject WPP.js
    injectWPP();

    // Step 7: Set up API bridge (CustomEvent -> background.js routing)
    setupAPIBridge();

    updateLoadingMessage("Ready!");

    // Clear the message timer and hide overlay
    clearInterval(messageTimer);
    hideLoadingOverlay();

    console.log("[OceanCRM] Initialization complete!");
    showToast("OceanCRM loaded", "success");
  } catch (error) {
    console.error("[OceanCRM] Initialization failed:", error);
    hideLoadingOverlay();
    showToast("Failed to initialize CRM", "error");
  }
}

// Start when page is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeExtension);
} else {
  initializeExtension();
}

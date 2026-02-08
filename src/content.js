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

// ============ UTILITIES ============
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

function sanitizePhone(value) {
  if (!value) {
    return "";
  }
  const digits = value.replace(/[^+\d]/g, "");
  return digits;
}

// ============ PROMISE-BASED ELEMENT DETECTION ============
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

function detectPhoneFromInfoPanel() {
  const panelSelectors = [
    "div[data-testid='drawer-right']",
    "section[aria-label*='Contact']",
    "section[aria-label*='contact']",
    "div[data-testid='contact-info-drawer']",
    "#app aside",
    "span[data-testid='chat-info-drawer']",
  ];

  let panel = null;
  for (const selector of panelSelectors) {
    const match = document.querySelector(selector);
    if (match) {
      panel = match;
      break;
    }
  }

  if (!panel) {
    return "";
  }

  // Look for phone labels and their values
  const nodes = panel.querySelectorAll("span, div, p");
  for (const node of nodes) {
    const label = (node.textContent || "").trim().toLowerCase();
    if (
      label === "phone" ||
      label === "phone:" ||
      label === "mobile" ||
      label === "mobile:" ||
      label.includes("phone number")
    ) {
      // Check next sibling
      const next = node.nextElementSibling;
      if (next && next.textContent) {
        const phoneMatch = next.textContent.match(/\+?\d[\d\s()\-]{6,}/);
        if (phoneMatch) {
          return sanitizePhone(phoneMatch[0]);
        }
      }
      // Check parent's next sibling
      const parentNext = node.parentElement?.nextElementSibling;
      if (parentNext && parentNext.textContent) {
        const phoneMatch = parentNext.textContent.match(/\+?\d[\d\s()\-]{6,}/);
        if (phoneMatch) {
          return sanitizePhone(phoneMatch[0]);
        }
      }
    }
  }

  // Fallback: find any phone-like pattern in the panel
  const fallbackText = panel.textContent || "";
  const fallbackMatches = fallbackText.match(/\+?\d[\d\s()\-]{6,}/g);
  if (!fallbackMatches || !fallbackMatches.length) {
    return "";
  }

  return sanitizePhone(fallbackMatches[fallbackMatches.length - 1]);
}

// Extract phone from WhatsApp URL hash (e.g., #/chat/+1234567890 or +1234567890@c.us)
function detectPhoneFromUrl() {
  const hash = window.location.hash || "";

  // Pattern: @c.us or @s.whatsapp.net format (WhatsApp internal)
  const cidMatch = hash.match(/(\d{7,15})@[cs]\.(?:us|whatsapp\.net)/);
  if (cidMatch) {
    return sanitizePhone(cidMatch[1]);
  }

  // Pattern: Direct phone in URL hash
  const phoneInHash = hash.match(/\+?(\d{7,15})/);
  if (phoneInHash) {
    return sanitizePhone(phoneInHash[0]);
  }

  return "";
}

// Extract phone from data-id attribute on chat elements
function detectPhoneFromDataId() {
  // WhatsApp stores phone numbers in data-id attributes like "1234567890@c.us"
  const chatSelectors = [
    '#main [data-id*="@c.us"]',
    '#main [data-id*="@s.whatsapp.net"]',
    '[data-testid="conversation-panel-wrapper"] [data-id*="@"]',
    'div[data-testid="cell-frame-container"][data-id*="@"]',
  ];

  for (const selector of chatSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const dataId = el.getAttribute("data-id") || "";
      const match = dataId.match(/(\d{7,15})@/);
      if (match) {
        return sanitizePhone(match[1]);
      }
    }
  }

  return "";
}

// Extract phone from the active chat in the list
function detectPhoneFromChatList() {
  // Look for the currently selected/active chat
  const activeChat =
    document.querySelector(
      '[data-testid="cell-frame-container"][aria-selected="true"]',
    ) ||
    document.querySelector(
      'div[tabindex="-1"][data-testid="cell-frame-container"]:focus-within',
    );

  if (activeChat) {
    const dataId = activeChat.getAttribute("data-id") || "";
    const match = dataId.match(/(\d{7,15})@/);
    if (match) {
      return sanitizePhone(match[1]);
    }
  }

  return "";
}

function detectChatInfo() {
  // Try multiple selectors for chat header name
  const headerSelectors = [
    "header span[title]",
    'header [data-testid="conversation-header"] span[title]',
    'header [data-testid="conversation-info-header"] span[title]',
    "#main header span[title]",
    '#main header span[dir="auto"]',
    'div[data-testid="conversation-panel-wrapper"] header span[title]',
  ];

  let rawTitle = "";
  for (const selector of headerSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      rawTitle = el.getAttribute("title") || el.textContent || "";
      if (rawTitle) break;
    }
  }

  // Try to get phone from header title if it looks like a phone number
  const phoneMatch = rawTitle && rawTitle.match(/\+?\d[\d\s()\-]{6,}/);

  // Try multiple detection methods (in priority order)
  let detectedPhone = "";

  // 1. Phone from URL (most reliable for active conversion)
  if (!detectedPhone) {
    detectedPhone = detectPhoneFromUrl();
  }

  // 2. Phone from data-id attributes
  if (!detectedPhone) {
    detectedPhone = detectPhoneFromDataId();
  }

  // 3. Phone from chat list
  if (!detectedPhone) {
    detectedPhone = detectPhoneFromChatList();
  }

  // 4. Phone from info panel
  if (!detectedPhone) {
    detectedPhone = detectPhoneFromInfoPanel();
  }

  // 5. Phone from header (if title is a phone number)
  if (!detectedPhone && phoneMatch) {
    detectedPhone = sanitizePhone(phoneMatch[0]);
  }

  // 6. Try to detect phone from main conversation area
  if (!detectedPhone) {
    const mainHeader = document.querySelector("#main header");
    if (mainHeader) {
      const allSpans = mainHeader.querySelectorAll("span");
      for (const span of allSpans) {
        const text = span.textContent || "";
        const match = text.match(/\+?\d[\d\s()\-]{8,}/);
        if (match) {
          detectedPhone = sanitizePhone(match[0]);
          break;
        }
      }
    }
  }

  // If title looks like phone number, try to get actual name from elsewhere
  let name = rawTitle;
  if (phoneMatch && rawTitle === phoneMatch[0]) {
    // Title is just a phone number, name is unknown
    name = "";
  }

  console.log("[OceanCRM] Detected:", { name, phone: detectedPhone, rawTitle });

  return {
    name: name || "",
    phone: detectedPhone || "",
  };
}

function detectChatPreview() {
  const messages = document.querySelectorAll(
    "div[role='row'] span.selectable-text",
  );
  const last = messages.length ? messages[messages.length - 1] : null;
  return last ? last.textContent || "" : "";
}

// ============ SIDEBAR PANEL (KRAYA-STYLE) ============
function ensureSidebar() {
  if (document.getElementById("ocrm-sidebar")) {
    return;
  }

  const sidebar = document.createElement("div");
  sidebar.id = "ocrm-sidebar";
  sidebar.className = "ocrm-sidebar";
  sidebar.innerHTML = `
    <div class="ocrm-sidebar-tabs">
      <div class="ocrm-sidebar-tab active" data-tab="lead-info">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
          <circle cx="12" cy="7" r="4"/>
        </svg>
        <strong>Lead Info</strong>
      </div>
      <div class="ocrm-sidebar-tab" data-tab="quick-replies">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        <strong>Quick Actions</strong>
      </div>
      <div class="ocrm-sidebar-tab" data-tab="settings">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="3"/>
          <path d="M12 1v4m0 14v4m11-11h-4M5 12H1m16.95-6.95l-2.83 2.83M7.88 16.12l-2.83 2.83m0-13.9l2.83 2.83m8.24 8.24l2.83 2.83"/>
        </svg>
        <strong>Settings</strong>
      </div>
    </div>
    
    <div class="ocrm-sidebar-content">
      <!-- Lead Info Tab -->
      <div class="ocrm-tab-pane active" id="ocrm-pane-lead-info">
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Contact Details</h3>
          </div>
          <div class="ocrm-section-body">
            <div class="ocrm-field">
              <label>Name</label>
              <input id="ocrm-sidebar-name" type="text" placeholder="Contact name" />
            </div>
            <div class="ocrm-field">
              <label>Phone</label>
              <input id="ocrm-sidebar-phone" type="text" placeholder="+1234567890" />
            </div>
            <div class="ocrm-field">
              <label>Email</label>
              <input id="ocrm-sidebar-email" type="email" placeholder="email@example.com" />
            </div>
          </div>
        </div>
        
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Lead Stage</h3>
          </div>
          <div class="ocrm-section-body">
            <div class="ocrm-field">
              <label>Stage</label>
              <select id="ocrm-sidebar-stage"></select>
            </div>
          </div>
        </div>
        
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Notes</h3>
          </div>
          <div class="ocrm-section-body">
            <textarea id="ocrm-sidebar-notes" rows="4" placeholder="Add notes about this lead..."></textarea>
          </div>
        </div>
        
        <div class="ocrm-sidebar-actions">
          <button id="ocrm-sidebar-create" class="ocrm-btn-primary">Create Lead</button>
          <button id="ocrm-sidebar-refresh" class="ocrm-btn-secondary">Refresh</button>
        </div>
        
        <div id="ocrm-sidebar-status" class="ocrm-sidebar-status"></div>
      </div>
      
      <!-- Quick Actions Tab -->
      <div class="ocrm-tab-pane" id="ocrm-pane-quick-replies">
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Quick Capture</h3>
          </div>
          <div class="ocrm-section-body">
            <p class="ocrm-hint">Paste any text (WhatsApp chat, email, etc.) to extract lead info automatically.</p>
            <textarea id="ocrm-sidebar-paste" rows="5" placeholder="Paste text here..."></textarea>
            <button id="ocrm-sidebar-apply-paste" class="ocrm-btn-secondary">Extract & Apply</button>
          </div>
        </div>
        
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Quick Lead from Chat</h3>
          </div>
          <div class="ocrm-section-body">
            <div class="ocrm-detected-info">
              <div class="ocrm-detected-row">
                <span>Detected Name:</span>
                <strong id="ocrm-detected-name">-</strong>
              </div>
              <div class="ocrm-detected-row">
                <span>Detected Phone:</span>
                <strong id="ocrm-detected-phone">-</strong>
              </div>
            </div>
            <button id="ocrm-sidebar-quick-create" class="ocrm-btn-primary">Create from Chat</button>
          </div>
        </div>
      </div>
      
      <!-- Settings Tab -->
      <div class="ocrm-tab-pane" id="ocrm-pane-settings">
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>API Configuration</h3>
          </div>
          <div class="ocrm-section-body">
            <div class="ocrm-field">
              <label>API Base URL</label>
              <input id="ocrm-sidebar-base-url" type="text" placeholder="http://localhost:8000/api" />
              <button id="ocrm-sidebar-save-url" class="ocrm-btn-secondary" style="margin-top:8px">Save URL</button>
            </div>
          </div>
        </div>
        
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Session</h3>
          </div>
          <div class="ocrm-section-body">
            <div class="ocrm-session-info">
              <span>Status:</span>
              <strong id="ocrm-sidebar-session-status">Not checked</strong>
            </div>
            <button id="ocrm-sidebar-check-session" class="ocrm-btn-secondary">Check Session</button>
          </div>
        </div>
        
        <div class="ocrm-section">
          <div class="ocrm-section-header">
            <h3>Organization</h3>
          </div>
          <div class="ocrm-section-body">
            <div class="ocrm-field">
              <label>Select Organization</label>
              <select id="ocrm-sidebar-orgs"></select>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Sidebar toggle button
  const toggleBtn = document.createElement("button");
  toggleBtn.id = "ocrm-sidebar-toggle";
  toggleBtn.className = "ocrm-sidebar-toggle";
  toggleBtn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>`;

  document.body.appendChild(sidebar);
  document.body.appendChild(toggleBtn);

  // Tab switching
  sidebar.querySelectorAll(".ocrm-sidebar-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const tabName = tab.dataset.tab;
      sidebar
        .querySelectorAll(".ocrm-sidebar-tab")
        .forEach((t) => t.classList.remove("active"));
      sidebar
        .querySelectorAll(".ocrm-tab-pane")
        .forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`ocrm-pane-${tabName}`)?.classList.add("active");
    });
  });

  // Toggle sidebar
  toggleBtn.addEventListener("click", () => {
    sidebar.classList.toggle("collapsed");
    toggleBtn.classList.toggle("collapsed");
  });

  initSidebarEvents();
}

function initSidebarEvents() {
  // Save URL button
  const saveUrlBtn = document.getElementById("ocrm-sidebar-save-url");
  if (saveUrlBtn) {
    saveUrlBtn.addEventListener("click", async () => {
      const urlInput = document.getElementById("ocrm-sidebar-base-url");
      const value = urlInput?.value.trim() || DEFAULT_BASE_URL;
      await chrome.storage.local.set({ baseUrl: value });
      showToast("API URL saved", "success");
    });
  }

  // Check session button
  const checkSessionBtn = document.getElementById("ocrm-sidebar-check-session");
  if (checkSessionBtn) {
    checkSessionBtn.addEventListener("click", async () => {
      const baseUrl = await loadBaseUrl();
      await refreshSessionSidebar(baseUrl);
    });
  }

  // Org select change
  const orgSelect = document.getElementById("ocrm-sidebar-orgs");
  if (orgSelect) {
    orgSelect.addEventListener("change", async (e) => {
      const orgId = e.target.value;
      await chrome.storage.local.set({ orgId });
      const baseUrl = await loadBaseUrl();
      await loadStagesSidebar(baseUrl, orgId);
    });
  }

  // Stage select change
  const stageSelect = document.getElementById("ocrm-sidebar-stage");
  if (stageSelect) {
    stageSelect.addEventListener("change", async (e) => {
      await chrome.storage.local.set({ stageName: e.target.value });
    });
  }

  // Create lead button
  const createBtn = document.getElementById("ocrm-sidebar-create");
  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      const baseUrl = await loadBaseUrl();
      await createLeadFromSidebar(baseUrl);
    });
  }

  // Refresh button
  const refreshBtn = document.getElementById("ocrm-sidebar-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => {
      fillSidebarFields();
    });
  }

  // Quick create from chat
  const quickCreateBtn = document.getElementById("ocrm-sidebar-quick-create");
  if (quickCreateBtn) {
    quickCreateBtn.addEventListener("click", async () => {
      const baseUrl = await loadBaseUrl();
      await createLeadFromChatSidebar(baseUrl);
    });
  }

  // Apply paste button
  const applyPasteBtn = document.getElementById("ocrm-sidebar-apply-paste");
  if (applyPasteBtn) {
    applyPasteBtn.addEventListener("click", () => {
      const input = document.getElementById("ocrm-sidebar-paste");
      if (input?.value) {
        applySidebarPaste(input.value);
        input.value = "";
        showToast("Lead info extracted", "success");
      }
    });
  }
}

async function refreshSessionSidebar(baseUrl) {
  const statusEl = document.getElementById("ocrm-sidebar-session-status");
  if (statusEl) statusEl.textContent = "Checking...";

  const result = await sendMessage({ type: "pingAuth", baseUrl });
  if (!result.ok) {
    if (statusEl) {
      statusEl.textContent = result.error || "Auth failed";
      statusEl.classList.add("error");
    }
    return false;
  }

  if (statusEl) {
    statusEl.textContent = "Signed in ✓";
    statusEl.classList.remove("error");
  }

  await loadOrgsSidebar(baseUrl);
  return true;
}

async function loadOrgsSidebar(baseUrl) {
  const result = await sendMessage({ type: "getOrgs", baseUrl });
  const orgSelect = document.getElementById("ocrm-sidebar-orgs");
  if (!orgSelect) return;

  orgSelect.innerHTML = "";

  if (!result.ok) {
    showToast(result.error || "Failed to load orgs", "error");
    return;
  }

  const orgs = result.data || [];
  for (const org of orgs) {
    const opt = document.createElement("option");
    opt.value = org.id;
    opt.textContent = org.name;
    orgSelect.appendChild(opt);
  }

  const stored = await chrome.storage.local.get({ orgId: "" });
  if (stored.orgId && orgs.some((o) => o.id === stored.orgId)) {
    orgSelect.value = stored.orgId;
  } else if (orgs.length > 0) {
    // Auto-select first org and save to storage
    orgSelect.value = orgs[0].id;
    await chrome.storage.local.set({ orgId: orgs[0].id });
  }

  if (orgSelect.value) {
    await loadStagesSidebar(baseUrl, orgSelect.value);
  }
}

async function loadStagesSidebar(baseUrl, orgId) {
  const result = await sendMessage({ type: "getStages", baseUrl, orgId });
  const stageSelect = document.getElementById("ocrm-sidebar-stage");
  if (!stageSelect) return;

  stageSelect.innerHTML = "";

  if (!result.ok) {
    showToast(result.error || "Failed to load stages", "error");
    return;
  }

  const stages = result.data || [];
  for (const stage of stages) {
    const opt = document.createElement("option");
    opt.value = stage.stage;
    opt.textContent = stage.stage;
    stageSelect.appendChild(opt);
  }

  const stored = await chrome.storage.local.get({ stageName: "" });
  if (stored.stageName && stages.some((s) => s.stage === stored.stageName)) {
    stageSelect.value = stored.stageName;
  } else if (stages.length > 0) {
    // Auto-select first stage and save to storage
    stageSelect.value = stages[0].stage;
    await chrome.storage.local.set({ stageName: stages[0].stage });
  }
}

function fillSidebarFields() {
  const info = detectChatInfo();

  const nameInput = document.getElementById("ocrm-sidebar-name");
  const phoneInput = document.getElementById("ocrm-sidebar-phone");
  const detectedName = document.getElementById("ocrm-detected-name");
  const detectedPhone = document.getElementById("ocrm-detected-phone");

  if (nameInput) nameInput.value = info.name || "";
  if (phoneInput) phoneInput.value = info.phone || "";
  if (detectedName) detectedName.textContent = info.name || "-";
  if (detectedPhone) detectedPhone.textContent = info.phone || "-";
}

function applySidebarPaste(text) {
  const parsed = parseQuickPaste(text);
  const nameInput = document.getElementById("ocrm-sidebar-name");
  const phoneInput = document.getElementById("ocrm-sidebar-phone");
  const emailInput = document.getElementById("ocrm-sidebar-email");
  const notesInput = document.getElementById("ocrm-sidebar-notes");

  if (nameInput && parsed.name) nameInput.value = parsed.name;
  if (phoneInput && parsed.phone) phoneInput.value = parsed.phone;
  if (emailInput && parsed.email) emailInput.value = parsed.email;
  if (notesInput && parsed.notes) notesInput.value = parsed.notes;
}

async function createLeadFromSidebar(baseUrl) {
  // Get orgId from storage, fallback to dropdown value
  let stored = await chrome.storage.local.get({ orgId: "" });
  let orgId = stored.orgId;

  if (!orgId) {
    // Try to get from dropdown directly
    const orgSelect = document.getElementById("ocrm-sidebar-orgs");
    orgId = orgSelect?.value || "";
    if (orgId) {
      await chrome.storage.local.set({ orgId });
    }
  }

  if (!orgId) {
    showToast("Select an organization first", "error");
    return;
  }

  const name = document.getElementById("ocrm-sidebar-name")?.value.trim() || "";
  const phone = sanitizePhone(
    document.getElementById("ocrm-sidebar-phone")?.value || "",
  );
  const email =
    document.getElementById("ocrm-sidebar-email")?.value.trim() || "";
  const notes = document.getElementById("ocrm-sidebar-notes")?.value || "";
  const stage =
    document.getElementById("ocrm-sidebar-stage")?.value || "RAW (UNQUALIFIED)";

  if (!name && !phone) {
    showToast("Provide at least a name or phone", "error");
    return;
  }

  const lead = {
    assigned_to: null,
    tags: [],
    stage: stage,
    source_id: null,
    product_id: null,
    potential: 0,
    requirements: "",
    notes: notes,
    since: new Date().toISOString(),
    business: {
      business: name || phone,
      name: name,
      title: null,
      designation: "",
      mobile: phone,
      email: email,
      website: "",
      address_line_1: "",
      address_line_2: "",
      city: "",
      country: "",
      gstin: "",
      code: "",
    },
  };

  const statusEl = document.getElementById("ocrm-sidebar-status");
  if (statusEl) statusEl.textContent = "Creating lead...";

  const result = await sendMessage({
    type: "createLead",
    baseUrl,
    orgId,
    lead,
  });

  if (!result.ok) {
    if (statusEl) {
      statusEl.textContent = result.error || "Failed";
      statusEl.classList.add("error");
    }
    showToast(result.error || "Lead creation failed", "error");
    return;
  }

  if (statusEl) {
    statusEl.textContent = "Lead created ✓";
    statusEl.classList.remove("error");
  }
  showToast("Lead created successfully!", "success");
}

async function createLeadFromChatSidebar(baseUrl) {
  const info = detectChatInfo();
  let stored = await chrome.storage.local.get({ orgId: "", stageName: "" });

  // Get orgId from storage, fallback to dropdown value
  let orgId = stored.orgId;
  if (!orgId) {
    const orgSelect = document.getElementById("ocrm-sidebar-orgs");
    orgId = orgSelect?.value || "";
    if (orgId) {
      await chrome.storage.local.set({ orgId });
    }
  }

  // Get stage from storage, fallback to dropdown value
  let stageName = stored.stageName;
  if (!stageName) {
    const stageSelect = document.getElementById("ocrm-sidebar-stage");
    stageName = stageSelect?.value || "RAW (UNQUALIFIED)";
    if (stageSelect?.value) {
      await chrome.storage.local.set({ stageName: stageSelect.value });
    }
  }

  if (!orgId) {
    showToast("Select organization first", "error");
    return;
  }

  const name = (info.name || "").trim();
  const phone = sanitizePhone(info.phone || "");

  if (!name && !phone) {
    showToast("No contact details detected", "error");
    return;
  }

  const lead = {
    assigned_to: null,
    tags: [],
    stage: stageName,
    source_id: null,
    product_id: null,
    potential: 0,
    requirements: "",
    notes: detectChatPreview() || "",
    since: new Date().toISOString(),
    business: {
      business: name || phone,
      name: name,
      title: null,
      designation: "",
      mobile: phone,
      email: "",
      website: "",
      address_line_1: "",
      address_line_2: "",
      city: "",
      country: "",
      gstin: "",
      code: "",
    },
  };

  const result = await sendMessage({
    type: "createLead",
    baseUrl,
    orgId,
    lead,
  });

  if (!result.ok) {
    showToast(result.error || "Lead creation failed", "error");
    return;
  }

  showToast("Lead created from chat!", "success");
}

function ensureWidget() {
  if (document.getElementById("ocrm-toggle")) {
    return;
  }

  const toggle = document.createElement("button");
  toggle.id = "ocrm-toggle";
  toggle.className = "ocrm-toggle";
  toggle.textContent = "CRM";

  const widget = document.createElement("div");
  widget.id = "ocrm-widget";
  widget.className = "ocrm-widget";
  widget.innerHTML = `
    <div class="ocrm-header">
      <div class="ocrm-title">OceanCRM</div>
      <button class="ocrm-close" type="button">x</button>
    </div>
    <div class="ocrm-body">
      <div class="ocrm-row">
        <label>API Base</label>
        <div class="ocrm-inline">
          <input id="ocrm-base-url" type="text" placeholder="http://localhost:8000/api" />
          <button id="ocrm-save-base" type="button">Save</button>
        </div>
      </div>
      <div class="ocrm-row">
        <label>Session</label>
        <div class="ocrm-inline">
          <button id="ocrm-refresh-session" type="button">Refresh</button>
          <span id="ocrm-session-status" class="ocrm-muted">Not checked</span>
        </div>
      </div>
      <div class="ocrm-row">
        <label>Organization</label>
        <select id="ocrm-orgs"></select>
      </div>
      <div class="ocrm-row">
        <label>Stage</label>
        <select id="ocrm-stages"></select>
      </div>
      <div class="ocrm-row">
        <label>Quick Capture</label>
        <div class="ocrm-inline">
          <button id="ocrm-open-paste" type="button">Paste text</button>
          <span class="ocrm-muted">WhatsApp or email</span>
        </div>
      </div>
      <div class="ocrm-row">
        <label>Name</label>
        <input id="ocrm-name" type="text" />
      </div>
      <div class="ocrm-row">
        <label>Phone</label>
        <input id="ocrm-phone" type="text" />
      </div>
      <div class="ocrm-row">
        <label>Notes</label>
        <textarea id="ocrm-notes" rows="3" placeholder="WhatsApp context"></textarea>
      </div>
      <div class="ocrm-row">
        <button id="ocrm-create" type="button" class="ocrm-primary">Create lead</button>
      </div>
      <div id="ocrm-status" class="ocrm-status"></div>
    </div>
    <div id="ocrm-paste-modal" class="ocrm-modal" aria-hidden="true">
      <div class="ocrm-modal-card">
        <div class="ocrm-modal-header">
          <div>Quick Paste</div>
          <button id="ocrm-close-paste" type="button">x</button>
        </div>
        <textarea id="ocrm-paste-input" rows="7" placeholder="Paste WhatsApp chat, email, or lead details"></textarea>
        <div class="ocrm-modal-actions">
          <button id="ocrm-apply-paste" type="button" class="ocrm-primary">Apply</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(toggle);
  document.body.appendChild(widget);

  toggle.addEventListener("click", () => widget.classList.add("open"));
  widget.querySelector(".ocrm-close").addEventListener("click", () => {
    widget.classList.remove("open");
  });

  widget.querySelector("#ocrm-open-paste").addEventListener("click", () => {
    const modal = document.getElementById("ocrm-paste-modal");
    const input = document.getElementById("ocrm-paste-input");
    if (!modal || !input) {
      return;
    }
    const preview = detectChatPreview();
    if (preview && !input.value) {
      input.value = preview;
    }
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    input.focus();
  });

  widget.querySelector("#ocrm-close-paste").addEventListener("click", () => {
    const modal = document.getElementById("ocrm-paste-modal");
    if (!modal) {
      return;
    }
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
  });
}

async function loadBaseUrl() {
  const data = await chrome.storage.local.get({ baseUrl: DEFAULT_BASE_URL });
  return data.baseUrl || DEFAULT_BASE_URL;
}

async function saveBaseUrl(baseUrl) {
  await chrome.storage.local.set({ baseUrl });
}

function setStatus(message, isError = false) {
  const statusEl = document.getElementById("ocrm-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function setSessionStatus(message, isError = false) {
  const statusEl = document.getElementById("ocrm-session-status");
  if (!statusEl) {
    return;
  }
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

let lastDetectedChat = { name: "", phone: "" };

function fillChatFields() {
  const info = detectChatInfo();
  const nameInput = document.getElementById("ocrm-name");
  const phoneInput = document.getElementById("ocrm-phone");

  // Check if chat changed (different name or phone detected)
  const chatChanged =
    info.name !== lastDetectedChat.name ||
    info.phone !== lastDetectedChat.phone;

  if (chatChanged && (info.name || info.phone)) {
    lastDetectedChat = { name: info.name, phone: info.phone };
    if (nameInput) {
      nameInput.value = info.name || "";
    }
    if (phoneInput) {
      phoneInput.value = info.phone || "";
    }
  } else {
    // Only fill if empty (first load)
    if (nameInput && !nameInput.value) {
      nameInput.value = info.name || "";
    }
    if (phoneInput && !phoneInput.value) {
      phoneInput.value = info.phone || "";
    }
  }
}

function parseQuickPaste(text) {
  const result = {
    name: "",
    phone: "",
    email: "",
    company: "",
    notes: text.trim(),
  };

  if (!text) {
    return result;
  }

  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (emailMatch) {
    result.email = emailMatch[0];
  }

  const phoneMatch = text.match(/\+?\d[\d\s()\-]{6,}/);
  if (phoneMatch) {
    result.phone = sanitizePhone(phoneMatch[0]);
  }

  const nameLine = text
    .split(/\r?\n/)
    .find((line) => line.toLowerCase().includes("name"));
  if (nameLine) {
    const parts = nameLine.split(":");
    result.name = (parts[1] || "").trim();
  }

  const companyLine = text
    .split(/\r?\n/)
    .find(
      (line) =>
        line.toLowerCase().includes("company") ||
        line.toLowerCase().includes("business"),
    );
  if (companyLine) {
    const parts = companyLine.split(":");
    result.company = (parts[1] || "").trim();
  }

  return result;
}

function applyQuickPaste(text) {
  const parsed = parseQuickPaste(text);
  const nameInput = document.getElementById("ocrm-name");
  const phoneInput = document.getElementById("ocrm-phone");
  const notesInput = document.getElementById("ocrm-notes");

  if (nameInput && parsed.name && !nameInput.value) {
    nameInput.value = parsed.name;
  }

  if (phoneInput && parsed.phone && !phoneInput.value) {
    phoneInput.value = parsed.phone;
  }

  if (notesInput && parsed.notes) {
    notesInput.value = parsed.notes;
  }
}

async function refreshSession(baseUrl) {
  setSessionStatus("Checking...");
  const result = await sendMessage({ type: "pingAuth", baseUrl });
  if (!result.ok) {
    setSessionStatus(result.error || "Auth failed", true);
    return false;
  }
  setSessionStatus("Signed in");
  return true;
}

async function loadOrganizations(baseUrl) {
  const result = await sendMessage({ type: "getOrgs", baseUrl });
  const orgSelect = document.getElementById("ocrm-orgs");
  if (!orgSelect) {
    return;
  }

  orgSelect.innerHTML = "";

  if (!result.ok) {
    setStatus(result.error || "Failed to load organizations", true);
    return;
  }

  const orgs = result.data || [];
  for (const org of orgs) {
    const opt = document.createElement("option");
    opt.value = org.id;
    opt.textContent = org.name;
    orgSelect.appendChild(opt);
  }

  const stored = await chrome.storage.local.get({ orgId: "" });
  if (stored.orgId && orgs.some((o) => o.id === stored.orgId)) {
    orgSelect.value = stored.orgId;
  } else if (orgs.length > 0) {
    // Auto-select first org and save to storage
    orgSelect.value = orgs[0].id;
    await chrome.storage.local.set({ orgId: orgs[0].id });
  }
}

async function loadStages(baseUrl, orgId) {
  const result = await sendMessage({ type: "getStages", baseUrl, orgId });
  const stageSelect = document.getElementById("ocrm-stages");
  if (!stageSelect) {
    return;
  }

  stageSelect.innerHTML = "";

  if (!result.ok) {
    setStatus(result.error || "Failed to load stages", true);
    return;
  }

  const stages = result.data || [];
  for (const stage of stages) {
    const opt = document.createElement("option");
    opt.value = stage.stage;
    opt.textContent = stage.stage;
    stageSelect.appendChild(opt);
  }

  const stored = await chrome.storage.local.get({ stageName: "" });
  if (stored.stageName && stages.some((s) => s.stage === stored.stageName)) {
    stageSelect.value = stored.stageName;
  } else if (stages.length > 0) {
    // Auto-select first stage and save to storage
    stageSelect.value = stages[0].stage;
    await chrome.storage.local.set({ stageName: stages[0].stage });
  }
}

async function createLead(baseUrl) {
  const orgSelect = document.getElementById("ocrm-orgs");
  const stageSelect = document.getElementById("ocrm-stages");
  const nameInput = document.getElementById("ocrm-name");
  const phoneInput = document.getElementById("ocrm-phone");
  const notesInput = document.getElementById("ocrm-notes");

  if (!orgSelect || !stageSelect || !nameInput || !phoneInput || !notesInput) {
    return;
  }

  const orgId = orgSelect.value;
  if (!orgId) {
    setStatus("Select an organization first", true);
    return;
  }

  const name = nameInput.value.trim();
  const phone = sanitizePhone(phoneInput.value.trim());

  if (!name && !phone) {
    setStatus("Provide at least a name or phone", true);
    return;
  }

  const lead = {
    assigned_to: null,
    tags: [],
    stage: stageSelect.value || "RAW (UNQUALIFIED)",
    source_id: null,
    product_id: null,
    potential: 0,
    requirements: "",
    notes: notesInput.value || "",
    since: new Date().toISOString(),
    business: {
      business: name || phone,
      name: name,
      title: null,
      designation: "",
      mobile: phone,
      email: "",
      website: "",
      address_line_1: "",
      address_line_2: "",
      city: "",
      country: "",
      gstin: "",
      code: "",
    },
  };

  setStatus("Creating lead...");
  const result = await sendMessage({
    type: "createLead",
    baseUrl,
    orgId,
    lead,
  });
  if (!result.ok) {
    setStatus(result.error || "Lead creation failed", true);
    return;
  }

  setStatus("Lead created successfully");
}

async function initWidget() {
  ensureWidget();
  ensureSidebar();
  fillChatFields();
  fillSidebarFields();

  const baseUrl = await loadBaseUrl();
  const baseInput = document.getElementById("ocrm-base-url");
  const sidebarBaseInput = document.getElementById("ocrm-sidebar-base-url");

  if (baseInput) baseInput.value = baseUrl;
  if (sidebarBaseInput) sidebarBaseInput.value = baseUrl;

  // Auto-check session and load orgs/stages on initialization
  try {
    const widgetOk = await refreshSession(baseUrl);
    if (widgetOk) {
      await loadOrganizations(baseUrl);
      const orgSelect = document.getElementById("ocrm-orgs");
      if (orgSelect && orgSelect.value) {
        await loadStages(baseUrl, orgSelect.value);
      }
    }

    const sidebarOk = await refreshSessionSidebar(baseUrl);
    if (sidebarOk) {
      const sidebarOrgSelect = document.getElementById("ocrm-sidebar-orgs");
      if (sidebarOrgSelect && sidebarOrgSelect.value) {
        await loadStagesSidebar(baseUrl, sidebarOrgSelect.value);
      }
    }
  } catch (e) {
    console.warn("[OceanCRM] Auto-session check error:", e);
  }

  const saveBaseBtn = document.getElementById("ocrm-save-base");
  if (saveBaseBtn) {
    saveBaseBtn.addEventListener("click", async () => {
      const value = baseInput.value.trim() || DEFAULT_BASE_URL;
      await saveBaseUrl(value);
      setStatus("Saved API base");
      showToast("API URL saved", "success");
    });
  }

  const refreshBtn = document.getElementById("ocrm-refresh-session");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      const currentBase = baseInput.value.trim() || DEFAULT_BASE_URL;
      const ok = await refreshSession(currentBase);
      if (ok) {
        await loadOrganizations(currentBase);
        const orgSelect = document.getElementById("ocrm-orgs");
        if (orgSelect && orgSelect.value) {
          await loadStages(currentBase, orgSelect.value);
        }
      }
    });
  }

  const orgSelect = document.getElementById("ocrm-orgs");
  if (orgSelect) {
    orgSelect.addEventListener("change", async (event) => {
      const orgId = event.target.value;
      await chrome.storage.local.set({ orgId });
      const currentBase = baseInput.value.trim() || DEFAULT_BASE_URL;
      await loadStages(currentBase, orgId);
    });
  }

  const stageSelect = document.getElementById("ocrm-stages");
  if (stageSelect) {
    stageSelect.addEventListener("change", async (event) => {
      const stageName = event.target.value;
      await chrome.storage.local.set({ stageName });
    });
  }

  const createBtn = document.getElementById("ocrm-create");
  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      const currentBase = baseInput.value.trim() || DEFAULT_BASE_URL;
      await createLead(currentBase);
    });
  }

  const applyPasteBtn = document.getElementById("ocrm-apply-paste");
  if (applyPasteBtn) {
    applyPasteBtn.addEventListener("click", () => {
      const input = document.getElementById("ocrm-paste-input");
      if (!input) {
        return;
      }
      applyQuickPaste(input.value || "");
      input.value = "";
      const modal = document.getElementById("ocrm-paste-modal");
      if (modal) {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
      }
      setStatus("Quick paste applied");
      showToast("Lead info extracted", "success");
    });
  }

  let debounceTimer = null;
  function debouncedFill() {
    if (debounceTimer) {
      return;
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      try {
        fillChatFields();
        fillSidebarFields();
      } catch (e) {
        console.warn("[OceanCRM] fill error:", e);
      }
    }, 500);
  }

  const observer = new MutationObserver(debouncedFill);
  observer.observe(document.body, { subtree: true, childList: true });
}

// ============ MAIN INITIALIZATION WITH LOADING OVERLAY ============
async function initializeExtension() {
  console.log("[OceanCRM] Starting initialization...");

  try {
    // Show loading overlay with cycling messages
    showLoadingOverlay("Initializing OceanCRM...");
    const messageTimer = cycleLoadingMessages(5000);

    // Wait for WhatsApp to load using promise-based detection
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

    // Initialize the widget (includes auto session check)
    await initWidget();

    updateLoadingMessage("Ready!");

    // Clear the message timer
    clearInterval(messageTimer);

    // Hide loading overlay
    hideLoadingOverlay();

    console.log("[OceanCRM] Initialization complete!");
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

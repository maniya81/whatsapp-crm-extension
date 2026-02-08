const DEFAULT_BASE_URL = "http://localhost:8000/api";

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

function detectChatInfo() {
  const header = document.querySelector("header");
  const titleEl = header ? header.querySelector("span[title]") : null;
  const rawTitle = titleEl
    ? titleEl.getAttribute("title") || titleEl.textContent
    : "";
  const phoneMatch = rawTitle && rawTitle.match(/\+?\d[\d\s()\-]{6,}/);
  return {
    name: rawTitle || "",
    phone: phoneMatch ? sanitizePhone(phoneMatch[0]) : "",
  };
}

function detectChatPreview() {
  const messages = document.querySelectorAll(
    "div[role='row'] span.selectable-text",
  );
  const last = messages.length ? messages[messages.length - 1] : null;
  return last ? last.textContent || "" : "";
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

function fillChatFields() {
  const info = detectChatInfo();
  const nameInput = document.getElementById("ocrm-name");
  const phoneInput = document.getElementById("ocrm-phone");
  if (nameInput && !nameInput.value) {
    nameInput.value = info.name || "";
  }
  if (phoneInput && !phoneInput.value) {
    phoneInput.value = info.phone || "";
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
  if (stored.orgId) {
    orgSelect.value = stored.orgId;
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
  fillChatFields();

  const baseUrl = await loadBaseUrl();
  const baseInput = document.getElementById("ocrm-base-url");
  if (baseInput) {
    baseInput.value = baseUrl;
  }

  document
    .getElementById("ocrm-save-base")
    .addEventListener("click", async () => {
      const value = baseInput.value.trim() || DEFAULT_BASE_URL;
      await saveBaseUrl(value);
      setStatus("Saved API base");
    });

  document
    .getElementById("ocrm-refresh-session")
    .addEventListener("click", async () => {
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

  document
    .getElementById("ocrm-orgs")
    .addEventListener("change", async (event) => {
      const orgId = event.target.value;
      await chrome.storage.local.set({ orgId });
      const currentBase = baseInput.value.trim() || DEFAULT_BASE_URL;
      await loadStages(currentBase, orgId);
    });

  document.getElementById("ocrm-create").addEventListener("click", async () => {
    const currentBase = baseInput.value.trim() || DEFAULT_BASE_URL;
    await createLead(currentBase);
  });

  document.getElementById("ocrm-apply-paste").addEventListener("click", () => {
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
  });

  const observer = new MutationObserver(() => fillChatFields());
  observer.observe(document.body, { subtree: true, childList: true });
}

initWidget();

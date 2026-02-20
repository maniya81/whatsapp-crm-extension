// ============================================================
// WPP.JS INJECTION & EVENT BRIDGE
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

// Inject WPP.js immediately on load
injectWPP();

// ============================================================
// LEAD CACHE — Phone-to-Stage Mapping
// ============================================================

/** @type {Map<string, {stage: string, leadId: string, name: string, wa_chat_id: string|null}>} */
let phoneStageMap = new Map();

/** @type {Map<string, string>} wa_chat_id → normalized phone (for quick dedup) */
let waChatIdMap = new Map();

/** @type {Array<{stage: string, order: number}>} */
let stagesList = [];

/** @type {string|null} */
let activeStageFilter = null;

/** @type {Map<string, number>} */
let stageCounts = new Map();

/** @type {Array<{id: object, name: string, isGroup: boolean}>} Cached WPP chat list */
let cachedChatList = [];

// ============================================================
// CHAT STAGE BUCKETS — Custom Chat List Data
// ============================================================

/**
 * Per-stage arrays of {chat, lead, phone} objects.
 * Built by merging cachedChatList (WPP) + phoneStageMap (API).
 *
 * Key = stage name (e.g., "RAW (UNQUALIFIED)")
 * Value = Array<{ chat: WPPChat, lead: LeadData, phone: string }>
 *
 * Equivalent to Kraya's D[slug] buckets.
 * @type {Map<string, Array<{chat: object, lead: object, phone: string}>>}
 */
let chatsByStage = new Map();

/**
 * Lead data indexed by WPP chat serialized ID.
 * Allows quick lead lookup when rendering or clicking a chat item.
 *
 * Equivalent to Kraya's B[serializedId].
 * @type {Map<string, {stage: string, leadId: string, name: string, wa_chat_id: string|null}>}
 */
let leadByChatId = new Map();

/**
 * WPP chat object indexed by serialized ID.
 * Equivalent to Kraya's T[serializedId].
 * @type {Map<string, object>}
 */
let chatById = new Map();

/**
 * Whether the custom chat list is currently visible (a stage filter is active).
 * @type {boolean}
 */
let customListVisible = false;

/**
 * Normalize a phone number for consistent matching.
 * Strips everything except digits.
 *
 * Examples:
 *   "+91 98765 43210"      → "919876543210"
 *   "919876543210@c.us"    → "919876543210"
 *   "+1-555-123-4567"      → "15551234567"
 *
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  if (!phone) return "";
  // Remove everything except digits
  var normalized = phone.replace(/[^0-9]/g, "");
  // Remove leading zeros
  normalized = normalized.replace(/^0+/, "");
  return normalized;
}

/**
 * Fetch ALL leads from the API (handles pagination).
 * Builds phoneStageMap and waChatIdMap.
 *
 * @param {string} baseUrl
 * @param {string} orgId
 * @returns {Promise<boolean>}
 */
async function loadAllLeads(baseUrl, orgId) {
  phoneStageMap.clear();
  waChatIdMap.clear();
  stageCounts.clear();

  var page = 1;
  var totalPages = 1;
  var totalLoaded = 0;

  // Last 365 days
  var since = new Date();
  since.setDate(since.getDate() - 365);
  var sinceStr = since.toISOString();

  try {
    while (page <= totalPages) {
      var response = await sendMessage({
        type: "getLeads",
        baseUrl: baseUrl,
        orgId: orgId,
        page: page,
        pageSize: 500,
        since: sinceStr,
      });

      if (!response.ok) {
        console.error(
          "[OceanCRM] Failed to load leads page",
          page,
          response.error,
        );
        return false;
      }

      var data = response.data;
      totalPages = data.total_pages;

      for (var i = 0; i < data.items.length; i++) {
        var lead = data.items[i];
        var phone = normalizePhone(lead.business && lead.business.mobile);
        if (phone) {
          phoneStageMap.set(phone, {
            stage: lead.stage,
            leadId: lead.id,
            name: (lead.business && lead.business.name) || "",
            wa_chat_id: lead.wa_chat_id || null,
          });
        }
        // Also index by wa_chat_id for fast dedup
        if (lead.wa_chat_id) {
          waChatIdMap.set(lead.wa_chat_id, phone);
        }
      }

      totalLoaded += data.items.length;
      page++;
    }

    console.log(
      "[OceanCRM] Loaded " +
        totalLoaded +
        " leads, mapped " +
        phoneStageMap.size +
        " phones",
    );

    recomputeStageCounts();
    return true;
  } catch (err) {
    console.error("[OceanCRM] Error loading leads:", err);
    return false;
  }
}

/**
 * Recompute per-stage lead counts.
 */
/**
 * Recompute per-stage counts FROM chatsByStage buckets.
 * REPLACES the old version that counted from phoneStageMap.
 *
 * The key difference: this counts leads that have a matching WPP chat,
 * not all leads in the CRM. If a lead has no WhatsApp chat,
 * it's still included via the dummy entry (see buildChatStageBuckets).
 */
function recomputeStageCounts() {
  stageCounts.clear();
  for (var i = 0; i < stagesList.length; i++) {
    var sName = stagesList[i].stage;
    var bucket = chatsByStage.get(sName);
    stageCounts.set(sName, bucket ? bucket.length : 0);
  }
}

/**
 * Look up the stage for a given phone number.
 * Tries exact match first, then last-10-digit fallback.
 *
 * @param {string} rawPhone
 * @returns {{stage: string, leadId: string, name: string, wa_chat_id: string|null} | null}
 */
function getStageForPhone(rawPhone) {
  var normalized = normalizePhone(rawPhone);
  if (!normalized) return null;

  // Exact match
  if (phoneStageMap.has(normalized)) {
    return phoneStageMap.get(normalized);
  }

  // Last 10 digit fallback (handles country code differences)
  var last10 = normalized.slice(-10);
  if (last10.length >= 10) {
    var entries = Array.from(phoneStageMap.entries());
    for (var i = 0; i < entries.length; i++) {
      if (entries[i][0].endsWith(last10)) {
        return entries[i][1];
      }
    }
  }

  return null;
}

/**
 * Check if a lead already exists for a given wa_chat_id (client-side dedup).
 * @param {string} waChatId - e.g., "919876543210@c.us"
 * @returns {boolean}
 */
function leadExistsForChat(waChatId) {
  return waChatIdMap.has(waChatId);
}

// ============================================================
// STAGE BAR — Chevron Tab UI
// ============================================================

/**
 * Create and inject the stage bar above WhatsApp's chat list.
 * @param {Array<{stage: string, order: number}>} stages
 */
function renderStageBar(stages) {
  // Remove existing if re-rendering
  var existing = document.getElementById("ocrm-stage-bar");
  if (existing) existing.remove();

  var stageBar = document.createElement("div");
  stageBar.id = "ocrm-stage-bar";
  stageBar.className = "ocrm-stage-bar";

  var tabsContainer = document.createElement("div");
  tabsContainer.id = "ocrm-stage-tabs";
  tabsContainer.className = "ocrm-stage-tabs";

  // "All" tab first
  var allTab = createStageTab("ALL", null, phoneStageMap.size);
  allTab.classList.add("ocrm-stage-tab-active");
  tabsContainer.appendChild(allTab);

  // Pipeline stage tabs
  for (var i = 0; i < stages.length; i++) {
    var count = stageCounts.get(stages[i].stage) || 0;
    var tab = createStageTab(stages[i].stage, stages[i].order, count);
    tabsContainer.appendChild(tab);
  }

  stageBar.appendChild(tabsContainer);

  // Inject above #side - try multiple strategies
  var injected = false;

  // Strategy 1: Insert before #side
  var sidePanel = document.getElementById("side");
  if (sidePanel && sidePanel.parentNode) {
    sidePanel.parentNode.insertBefore(stageBar, sidePanel);
    injected = true;
    console.log("[OceanCRM] Stage bar injected before #side");
  }

  // Strategy 2: Insert before #pane-side
  if (!injected) {
    var panePanel = document.querySelector("#pane-side");
    if (panePanel && panePanel.parentNode) {
      panePanel.parentNode.insertBefore(stageBar, panePanel);
      injected = true;
      console.log("[OceanCRM] Stage bar injected before #pane-side");
    }
  }

  // Strategy 3: Insert at app root
  if (!injected) {
    var app = document.querySelector("#app > div > div > div");
    if (app) {
      app.insertBefore(stageBar, app.firstChild);
      injected = true;
      console.log("[OceanCRM] Stage bar injected at app root");
    }
  }

  if (!injected) {
    console.error(
      "[OceanCRM] Failed to inject stage bar - no suitable container found",
    );
    return;
  }

  bindStageTabClicks();

  // Watch for removal and re-inject if needed
  watchStageBarRemoval();
}

/**
 * Create a single stage tab element.
 */
function createStageTab(stageName, order, count) {
  var tab = document.createElement("div");
  tab.className = "ocrm-stage-tab";
  tab.dataset.stage = stageName;

  var countEl = document.createElement("div");
  countEl.className = "ocrm-stage-tab-count";
  countEl.textContent = String(count);

  var nameEl = document.createElement("div");
  nameEl.className = "ocrm-stage-tab-name";
  nameEl.textContent = formatStageName(stageName);

  tab.appendChild(countEl);
  tab.appendChild(nameEl);
  return tab;
}

/**
 * Format stage name for display.
 * "RAW (UNQUALIFIED)" → "Raw"
 * "NEW" → "New"
 */
function formatStageName(stage) {
  if (stage === "ALL") return "All";
  var words = stage.split(/[\s(]+/);
  var primary = words[0];
  return primary.charAt(0).toUpperCase() + primary.slice(1).toLowerCase();
}

function bindStageTabClicks() {
  var tabs = document.querySelectorAll(".ocrm-stage-tab");
  tabs.forEach(function (tab) {
    tab.addEventListener("click", handleStageTabClick);
  });
}

/**
 * Handle stage tab click — filter or reset.
 */
/**
 * Handle stage tab click — show custom filtered list or restore native list.
 * REPLACES the old handleStageTabClick() that used filterChatList().
 */
function handleStageTabClick(e) {
  var tab = e.currentTarget;
  var stageName = tab.dataset.stage;

  // Double-click on active tab or "ALL" → reset
  if (
    (stageName === "ALL" && activeStageFilter === null) ||
    stageName === activeStageFilter
  ) {
    // Reset to "All" — show WhatsApp's native list
    activeStageFilter = null;
    highlightStageTab("ALL");
    hideCustomChatList();
    return;
  }

  // Click "ALL" explicitly
  if (stageName === "ALL") {
    activeStageFilter = null;
    highlightStageTab("ALL");
    hideCustomChatList();
    return;
  }

  // Activate a specific stage filter
  activeStageFilter = stageName;
  highlightStageTab(stageName);
  showCustomChatList(stageName);
}

/**
 * Highlight the active stage tab and deactivate others.
 * @param {string} stageName
 */
function highlightStageTab(stageName) {
  document.querySelectorAll(".ocrm-stage-tab").forEach(function (t) {
    t.classList.remove("ocrm-stage-tab-active");
  });
  var target = document.querySelector(
    '.ocrm-stage-tab[data-stage="' + stageName + '"]',
  );
  if (target) target.classList.add("ocrm-stage-tab-active");
}

/**
 * Show the custom chat list and hide WhatsApp's native list.
 * @param {string} stageName - Stage to display
 */
function showCustomChatList(stageName) {
  // 1. Hide WhatsApp's native chat list
  var panesSide = document.getElementById("pane-side");
  if (panesSide) panesSide.style.display = "none";

  // 2. Ensure custom container exists (WhatsApp may have rebuilt its DOM)
  var customList = document.getElementById("ocrm-chat-list");
  if (!customList) {
    console.warn("[OceanCRM] Custom chat list missing — re-creating");
    createCustomChatListContainer();
    customList = document.getElementById("ocrm-chat-list");
  }
  if (customList) customList.style.display = "";

  // 3. Render filtered chats
  renderFilteredChatList(stageName);

  customListVisible = true;
  console.log("[OceanCRM] Showing custom list for stage: " + stageName);
}

/**
 * Hide the custom chat list and restore WhatsApp's native list.
 */
function hideCustomChatList() {
  // 1. Hide custom list
  var customList = document.getElementById("ocrm-chat-list");
  if (customList) customList.style.display = "none";

  // 2. Restore WhatsApp's native chat list
  var panesSide = document.getElementById("pane-side");
  if (panesSide) panesSide.style.display = "";

  customListVisible = false;
  console.log("[OceanCRM] Restored native WhatsApp chat list");
}

/**
 * Handle click on a custom chat list item.
 * Uses WPP.chat API to open the chat in WhatsApp's native UI.
 *
 * @param {string} serializedId - e.g., "919876543210@c.us"
 * @param {boolean} isDummy - If true, this lead has no WA chat (just CRM data)
 */
async function handleChatItemClick(serializedId, isDummy) {
  if (isDummy) {
    showToast("No WhatsApp chat found for this contact", "info");
    return;
  }

  try {
    await wppRequest("openChat", { chatId: serializedId }, 5000);
    console.log("[OceanCRM] Opened chat: " + serializedId);
  } catch (err) {
    console.error("[OceanCRM] Failed to open chat:", err);
    showToast("Failed to open chat", "error");
  }
}

/**
 * Update counts on stage tabs.
 */
/**
 * Update counts displayed on stage tabs.
 * "All" tab shows total across all stages.
 */
function updateStageTabCounts() {
  var totalLeads = 0;
  chatsByStage.forEach(function (entries) {
    totalLeads += entries.length;
  });

  var tabs = document.querySelectorAll(".ocrm-stage-tab");
  tabs.forEach(function (tab) {
    var stageName = tab.dataset.stage;
    var countEl = tab.querySelector(".ocrm-stage-tab-count");
    if (!countEl) return;

    if (stageName === "ALL") {
      countEl.textContent = String(totalLeads);
    } else {
      countEl.textContent = String(stageCounts.get(stageName) || 0);
    }
  });
}

/**
 * Watch for stage bar removal and re-inject if needed.
 */
var stageBarObserver = null;

function watchStageBarRemoval() {
  if (stageBarObserver) {
    stageBarObserver.disconnect();
  }

  var appContainer = document.querySelector("#app");
  if (!appContainer) {
    console.warn("[OceanCRM] Cannot watch stage bar - #app not found");
    return;
  }

  stageBarObserver = new MutationObserver(function (mutations) {
    // Check if stage bar still exists
    var stageBar = document.getElementById("ocrm-stage-bar");
    if (!stageBar && stagesList.length > 0) {
      console.warn("[OceanCRM] Stage bar removed, re-injecting...");
      setTimeout(function () {
        renderStageBar(stagesList);
      }, 500);
    }
  });

  stageBarObserver.observe(appContainer, {
    childList: true,
    subtree: true,
  });

  console.log("[OceanCRM] Stage bar removal watcher active");
}

// ============================================================
// CHAT LIST FILTERING (WPP-Enhanced)
// ============================================================

/**
 * Build a map of phone → chat info from the WPP chat list cache.
 * This lets us look up phone numbers for DOM chat items without DOM scraping.
 *
 * @returns {Map<string, {serialized: string, name: string}>}
 */
function buildChatPhoneIndex() {
  var index = new Map();
  for (var i = 0; i < cachedChatList.length; i++) {
    var chat = cachedChatList[i];
    if (chat.isGroup) continue; // Skip groups
    var phone = normalizePhone(chat.id.user);
    if (phone) {
      index.set(phone, {
        serialized: chat.id._serialized,
        name: chat.name,
      });
    }
  }
  return index;
}

/**
 * Build per-stage chat buckets by merging phoneStageMap (API leads)
 * with cachedChatList (WPP chats).
 *
 * This is the OceanCRM equivalent of Kraya's mt() + et() functions.
 *
 * Called:
 *   - On init (after both loadAllLeads() and getChatList complete)
 *   - On lead cache refresh (every 5 minutes)
 *   - After creating a new lead
 */
function buildChatStageBuckets() {
  chatsByStage.clear();
  leadByChatId.clear();
  chatById.clear();

  // 1. Initialize empty arrays for each known stage
  for (var i = 0; i < stagesList.length; i++) {
    chatsByStage.set(stagesList[i].stage, []);
  }

  // 2. Index all WPP chats by serialized ID
  for (var j = 0; j < cachedChatList.length; j++) {
    var chat = cachedChatList[j];
    chatById.set(chat.id._serialized, chat);
  }

  // 3. For each non-group WPP chat, check if it has a CRM lead
  var matched = 0;
  var unmatched = 0;

  for (var k = 0; k < cachedChatList.length; k++) {
    var chat = cachedChatList[k];
    if (chat.isGroup) continue;

    var phone = normalizePhone(chat.id.user);
    if (!phone) continue;

    var leadData = getStageForPhone(phone);
    if (!leadData) {
      unmatched++;
      continue;
    }

    // Found a matching lead — bucket this chat
    var stageName = leadData.stage;
    var bucket = chatsByStage.get(stageName);
    if (!bucket) {
      // Stage exists in lead but not in stagesList (e.g., custom stage)
      bucket = [];
      chatsByStage.set(stageName, bucket);
    }

    var entry = {
      chat: chat,
      lead: leadData,
      phone: phone,
    };

    bucket.push(entry);
    leadByChatId.set(chat.id._serialized, leadData);
    matched++;
  }

  // 4. Also check for leads that have no WPP chat (phone saved in CRM but no WA chat)
  //    We create "dummy" entries for these so they appear in counts + filtered list
  phoneStageMap.forEach(function (leadData, phone) {
    // Check if this lead was already matched via WPP chat
    var alreadyMatched = false;
    var bucketForStage = chatsByStage.get(leadData.stage);
    if (bucketForStage) {
      for (var m = 0; m < bucketForStage.length; m++) {
        if (bucketForStage[m].phone === phone) {
          alreadyMatched = true;
          break;
        }
      }
    }

    if (!alreadyMatched) {
      // Create a dummy chat entry (lead exists but no active WA chat)
      var dummyChat = {
        id: {
          user: phone,
          server: "c.us",
          _serialized: phone + "@c.us",
        },
        name: leadData.name || "+" + phone,
        isGroup: false,
        unreadCount: 0,
        archive: false,
        timestamp: 0,
        _isDummy: true, // Flag to identify dummy entries
      };

      if (!bucketForStage) {
        bucketForStage = [];
        chatsByStage.set(leadData.stage, bucketForStage);
      }

      bucketForStage.push({
        chat: dummyChat,
        lead: leadData,
        phone: phone,
      });
    }
  });

  // 5. Sort each bucket by timestamp (newest first)
  chatsByStage.forEach(function (entries) {
    entries.sort(function (a, b) {
      return (b.chat.timestamp || 0) - (a.chat.timestamp || 0);
    });
  });

  // 6. Update stage counts
  stageCounts.clear();
  for (var s = 0; s < stagesList.length; s++) {
    var sName = stagesList[s].stage;
    var sBucket = chatsByStage.get(sName);
    stageCounts.set(sName, sBucket ? sBucket.length : 0);
  }

  console.log(
    "[OceanCRM] Chat stage buckets built: " +
      matched +
      " matched, " +
      unmatched +
      " unmatched (no CRM lead), " +
      chatsByStage.size +
      " stages",
  );
}

/**
 * Create and inject the custom chat list container.
 * Positioned exactly where WhatsApp's #pane-side is.
 * Hidden by default — shown when a stage filter is active.
 *
 * Equivalent to Kraya replacing WhatsApp's chat list container.
 */
function createCustomChatListContainer() {
  // Remove existing if re-creating
  var existing = document.getElementById("ocrm-chat-list");
  if (existing) existing.remove();

  var container = document.createElement("div");
  container.id = "ocrm-chat-list";
  container.className = "ocrm-chat-list";
  container.style.display = "none"; // Hidden by default

  // Header with filter info
  var header = document.createElement("div");
  header.className = "ocrm-chat-list-header";
  header.innerHTML =
    '<span id="ocrm-chat-list-title">Filtered Chats</span>' +
    '<span id="ocrm-chat-list-count" class="ocrm-chat-list-count"></span>';
  container.appendChild(header);

  // Empty state
  var emptyState = document.createElement("div");
  emptyState.id = "ocrm-chat-list-empty";
  emptyState.className = "ocrm-chat-list-empty";
  emptyState.style.display = "none";
  emptyState.innerHTML =
    '<div class="ocrm-empty-icon">📋</div>' +
    '<div class="ocrm-empty-text">No leads in this stage</div>' +
    '<div class="ocrm-empty-hint">Leads will appear here when assigned to this stage</div>';
  container.appendChild(emptyState);

  // Scrollable chat list area
  var scrollArea = document.createElement("div");
  scrollArea.id = "ocrm-chat-list-scroll";
  scrollArea.className = "ocrm-chat-list-scroll";
  container.appendChild(scrollArea);

  // Inject next to #pane-side (sibling, not child)
  var panesSide = document.getElementById("pane-side");
  if (panesSide && panesSide.parentNode) {
    panesSide.parentNode.insertBefore(container, panesSide.nextSibling);
    console.log("[OceanCRM] Custom chat list container created");
  } else {
    // Fallback: inject into #side or #app
    var side = document.getElementById("side");
    if (side) {
      side.appendChild(container);
      console.log("[OceanCRM] Custom chat list container created (in #side)");
    } else {
      console.error(
        "[OceanCRM] Cannot inject custom chat list — no container found",
      );
    }
  }
}

/**
 * Render the filtered chat list for a given stage.
 * Clears the custom list and populates it with chats from the stage bucket.
 *
 * @param {string} stageName - Stage to filter (e.g., "RAW (UNQUALIFIED)")
 */
function renderFilteredChatList(stageName) {
  var scrollArea = document.getElementById("ocrm-chat-list-scroll");
  var emptyState = document.getElementById("ocrm-chat-list-empty");
  var titleEl = document.getElementById("ocrm-chat-list-title");
  var countEl = document.getElementById("ocrm-chat-list-count");

  if (!scrollArea) {
    console.error("[OceanCRM] Custom chat list scroll area not found");
    return;
  }

  // Clear existing items
  scrollArea.innerHTML = "";

  // Get bucket
  var entries = chatsByStage.get(stageName) || [];

  // Update header
  if (titleEl) titleEl.textContent = formatStageName(stageName);
  if (countEl)
    countEl.textContent =
      entries.length + " lead" + (entries.length !== 1 ? "s" : "");

  // Show empty state if no entries
  if (entries.length === 0) {
    if (emptyState) emptyState.style.display = "";
    return;
  }
  if (emptyState) emptyState.style.display = "none";

  // Render each chat item
  for (var i = 0; i < entries.length; i++) {
    var item = renderChatItem(entries[i].chat, entries[i].lead);
    scrollArea.appendChild(item);
  }
}

/**
 * Create a single chat list item DOM element.
 * Simplified version of Kraya's ki() function.
 *
 * @param {object} chat - WPP chat object
 * @param {object} lead - Lead data from phoneStageMap
 * @returns {HTMLElement}
 */
function renderChatItem(chat, lead) {
  var item = document.createElement("div");
  item.className = "ocrm-chat-item";
  item.dataset.chatId = chat.id._serialized;
  item.dataset.phone = chat.id.user;

  // Mark dummy entries
  if (chat._isDummy) {
    item.classList.add("ocrm-chat-item-dummy");
  }

  // Avatar
  var avatar = document.createElement("div");
  avatar.className = "ocrm-chat-avatar";
  var initials = getInitials(chat.name || lead.name || chat.id.user);
  avatar.innerHTML =
    '<span class="ocrm-avatar-initials">' + initials + "</span>";
  item.appendChild(avatar);

  // Info section (name + last message)
  var info = document.createElement("div");
  info.className = "ocrm-chat-info";

  var nameEl = document.createElement("div");
  nameEl.className = "ocrm-chat-name";
  nameEl.textContent =
    chat.name || lead.name || formatPhoneDisplay(chat.id.user);
  info.appendChild(nameEl);

  // Last message preview
  var previewEl = document.createElement("div");
  previewEl.className = "ocrm-chat-preview";
  if (chat.lastMessageBody) {
    previewEl.textContent = chat.lastMessageBody;
  } else if (chat._isDummy) {
    previewEl.textContent = "No WhatsApp chat found";
    previewEl.classList.add("ocrm-chat-preview-muted");
  } else {
    previewEl.textContent = "";
  }
  info.appendChild(previewEl);

  item.appendChild(info);

  // Meta section (time + badges)
  var meta = document.createElement("div");
  meta.className = "ocrm-chat-meta";

  // Timestamp
  var timeEl = document.createElement("div");
  timeEl.className = "ocrm-chat-time";
  timeEl.textContent = chat.timestamp ? formatChatTime(chat.timestamp) : "";
  meta.appendChild(timeEl);

  // Unread badge
  if (chat.unreadCount > 0) {
    var unreadBadge = document.createElement("div");
    unreadBadge.className = "ocrm-chat-unread";
    unreadBadge.textContent = String(chat.unreadCount);
    meta.appendChild(unreadBadge);
  }

  item.appendChild(meta);

  // Click handler — open this chat in WhatsApp
  item.addEventListener("click", function () {
    handleChatItemClick(chat.id._serialized, chat._isDummy);
  });

  return item;
}

/**
 * Get initials from a name (for avatar).
 * "Srinet Global School" → "SG"
 * "+919876543210" → "91"
 */
function getInitials(name) {
  if (!name) return "?";
  var words = name.trim().split(/\s+/);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.substring(0, 2).toUpperCase();
}

/**
 * Format phone number for display.
 * "919876543210" → "+91 98765 43210"
 */
function formatPhoneDisplay(phone) {
  if (!phone) return "Unknown";
  if (phone.length > 10) {
    var cc = phone.substring(0, phone.length - 10);
    var rest = phone.substring(phone.length - 10);
    return "+" + cc + " " + rest.substring(0, 5) + " " + rest.substring(5);
  }
  return "+" + phone;
}

/**
 * Format a Unix timestamp into a human-readable relative time.
 *
 * @param {number} ts - Unix timestamp (seconds)
 * @returns {string}
 */
function formatChatTime(ts) {
  if (!ts) return "";
  var date = new Date(ts * 1000);
  var now = new Date();

  // Today
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // Yesterday
  var yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return "Yesterday";
  }

  // Within this week
  var diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));
  if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: "short" });
  }

  // Older
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

/**
 * Check if a lead already exists for the currently open chat.
 * Uses phoneStageMap (same pattern as Kraya's oa() function).
 *
 * @param {string} phone - Phone number of the contact
 * @returns {boolean}
 */
function isLeadAlreadyCreated(phone) {
  if (!phone) return false;
  var normalized = normalizePhone(phone);
  return phoneStageMap.has(normalized);
}

/**
 * Refresh lead data and rebuild stage buckets.
 * Called after creating a lead, org change, or on 5-minute timer.
 */
async function refreshLeadCache() {
  var stored = await new Promise(function (resolve) {
    chrome.storage.local.get(["baseUrl", "orgId"], resolve);
  });
  if (!stored.baseUrl || !stored.orgId) return;

  // Reload leads
  await loadAllLeads(stored.baseUrl, stored.orgId);

  // Reload WPP chat list (new chats may have appeared)
  try {
    cachedChatList = await wppRequest("getChatListEnriched", {}, 20000);
  } catch (err) {
    console.warn("[OceanCRM] WPP chat list refresh failed:", err);
  }

  // Rebuild buckets
  buildChatStageBuckets();
  updateStageTabCounts();

  // If a stage filter is active, re-render the custom list
  if (activeStageFilter && customListVisible) {
    renderFilteredChatList(activeStageFilter);
  }
}

// ============================================================
// STAGE FILTER INITIALIZATION
// ============================================================

/**
 * Initialize the full stage filtering feature.
 * Called after auth + org are confirmed.
 *
 * @param {string} baseUrl
 * @param {string} orgId
 */
async function initStageFilter(baseUrl, orgId) {
  try {
    console.log("[OceanCRM] Initializing stage filter...");
    showToast("Loading leads...", "info");

    // 1. Wait for WPP.js to be ready
    var wppTimeout = setTimeout(function () {
      console.warn("[OceanCRM] WPP.js timeout, falling back to DOM-only");
    }, 30000);

    try {
      await waitForWPPReady();
      clearTimeout(wppTimeout);
    } catch (err) {
      clearTimeout(wppTimeout);
      console.warn("[OceanCRM] WPP.js not available", err);
    }

    // 2. Load stages
    var stagesResponse = await sendMessage({
      type: "getStages",
      baseUrl: baseUrl,
      orgId: orgId,
    });
    if (!stagesResponse.ok || !stagesResponse.data) {
      console.error("[OceanCRM] Failed to load stages");
      showToast("Failed to load stages", "error");
      return;
    }
    stagesList = stagesResponse.data.sort(function (a, b) {
      return a.order - b.order;
    });

    // 3. Load all leads → phoneStageMap
    var success = await loadAllLeads(baseUrl, orgId);
    if (!success) {
      console.error("[OceanCRM] Failed to load leads");
      showToast("Failed to load leads", "error");
      return;
    }

    // 4. Load enriched WPP chat list (with last message bodies)
    try {
      cachedChatList = await wppRequest("getChatListEnriched", {}, 20000);
      console.log("[OceanCRM] Cached " + cachedChatList.length + " WPP chats");
    } catch (err) {
      console.warn("[OceanCRM] WPP chat list failed", err);
      cachedChatList = [];
    }

    // 5. BUILD CHAT STAGE BUCKETS (NEW — core of the fix)
    buildChatStageBuckets();

    // 6. Render stage bar (counts now come from chatsByStage)
    renderStageBar(stagesList);

    // 7. Create custom chat list container (hidden by default)
    createCustomChatListContainer();

    // 8. Start auto-refresh
    startStageRefreshInterval(baseUrl, orgId);

    window.__ocrmStageFilterReady = true;
    console.log("[OceanCRM] Stage filter initialized successfully");
    showToast(phoneStageMap.size + " leads loaded", "success");
  } catch (err) {
    console.error("[OceanCRM] Stage filter init error:", err);
    showToast("Stage filter initialization failed", "error");
  }
}

/**
 * Auto-refresh lead cache periodically.
 */
var stageRefreshInterval = null;

function startStageRefreshInterval(baseUrl, orgId) {
  if (stageRefreshInterval) clearInterval(stageRefreshInterval);
  stageRefreshInterval = setInterval(
    function () {
      refreshLeadCache();
    },
    5 * 60 * 1000,
  ); // Every 5 minutes
}

// ============================================================
// EXTENSION CONFIGURATION & UTILITIES
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

  // console.log("[OceanCRM] Detected:", { name, phone: detectedPhone, rawTitle });

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

  // Client-side duplicate check
  if (phone && isLeadAlreadyCreated(phone)) {
    showToast("Lead already exists for this contact", "warning");
    return;
  }

  // Get wa_chat_id from WPP
  var waChatId = null;
  if (phone) {
    var normalized = normalizePhone(phone);
    waChatId = normalized + "@c.us";

    // Try to get more accurate wa_chat_id from WPP
    try {
      var wppChat = await wppRequest("findChat", { phone: phone }, 5000);
      if (wppChat) {
        waChatId = wppChat.id._serialized;
      }
    } catch (e) {
      console.warn("[OceanCRM] WPP findChat error, using fallback", e);
    }
  }

  const lead = {
    assigned_to: null,
    tags: [],
    stage: stage,
    source_id: 3, // WHATSAPP_SOURCE_ID
    product_id: null,
    potential: 0,
    requirements: "",
    notes: notes,
    since: new Date().toISOString(),
    wa_chat_id: waChatId,
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

  // Refresh lead cache
  await refreshLeadCache();
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

  // Client-side duplicate check
  if (phone && isLeadAlreadyCreated(phone)) {
    showToast("Lead already exists for this contact", "warning");
    return;
  }

  // Get wa_chat_id from WPP
  var waChatId = null;
  if (phone) {
    var normalized = normalizePhone(phone);
    waChatId = normalized + "@c.us";

    // Try to get more accurate wa_chat_id from WPP
    try {
      var wppChat = await wppRequest("findChat", { phone: phone }, 5000);
      if (wppChat) {
        waChatId = wppChat.id._serialized;
      }
    } catch (e) {
      console.warn("[OceanCRM] WPP findChat error, using fallback", e);
    }
  }

  const lead = {
    assigned_to: null,
    tags: [],
    stage: stageName,
    source_id: 3, // WHATSAPP_SOURCE_ID
    product_id: null,
    potential: 0,
    requirements: "",
    notes: detectChatPreview() || "",
    since: new Date().toISOString(),
    wa_chat_id: waChatId,
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

  // Refresh lead cache
  await refreshLeadCache();
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
  const emailInput = document.getElementById("ocrm-email");

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

  // Client-side duplicate check
  if (phone && isLeadAlreadyCreated(phone)) {
    setStatus("Lead already exists for this contact", true);
    showToast("Lead already exists for this contact", "warning");
    return;
  }

  // Get chat phone for wa_chat_id
  var chatPhone = detectPhoneFromUrl() || detectPhoneFromDataId();
  var waChatId = null;
  if (chatPhone) {
    var normalized = normalizePhone(chatPhone);
    waChatId = normalized + "@c.us";

    // Try to get more accurate wa_chat_id from WPP
    try {
      var wppChat = await wppRequest("findChat", { phone: chatPhone }, 5000);
      if (wppChat) {
        waChatId = wppChat.id._serialized;
      }
    } catch (e) {
      console.warn("[OceanCRM] WPP findChat error, using fallback", e);
    }
  }

  const lead = {
    assigned_to: null,
    tags: [],
    stage: stageSelect.value || "RAW (UNQUALIFIED)",
    source_id: 3, // WHATSAPP_SOURCE_ID
    product_id: null,
    potential: 0,
    requirements: "",
    notes: notesInput.value || "",
    since: new Date().toISOString(),
    wa_chat_id: waChatId,
    business: {
      business: name || phone,
      name: name,
      title: null,
      designation: "",
      mobile: phone,
      email: emailInput?.value || "",
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

  // Refresh lead cache
  await refreshLeadCache();
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
        // Initialize stage filter after org is loaded
        await initStageFilter(baseUrl, orgSelect.value);
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
      // Reset and reinitialize stage filter when org changes
      activeStageFilter = null;
      await initStageFilter(currentBase, orgId);
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

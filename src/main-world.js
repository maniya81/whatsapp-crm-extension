/**
 * OceanCRM — MAIN World Script
 *
 * Runs in the page context (MAIN world) where window.WPP is available.
 * Listens for "ocean-request" CustomEvents from the ISOLATED world (content.js)
 * and responds with "ocean-response" events containing WPP API results.
 *
 * This script CANNOT access chrome.runtime, chrome.storage, or any
 * extension APIs — those are only available in the ISOLATED world.
 */

(function () {
  "use strict";

  // ================================================================
  // SECTION 1: GLOBAL STATE
  // ================================================================

  var wppReady = false;
  var uiVersion = "2.3"; // Safe default — 2.3 is current
  var isLoggedIn = false;
  var activeFilter = "all-chats";
  var selectedChat = null; // Currently opened chat (live Backbone model reference)

  // Data (populated by Phase 3)
  var leads = {}; // leads[chatId] = leadObject
  var buckets = {}; // buckets[slug] = [chatModel, chatModel, ...] — arrays of LIVE WPP Backbone models
  var stages = []; // [{id, stage, slug, order, color, is_default}]
  // var allChatIds = []; // REMOVED — replaced by liveChatModels
  var userData = null; // User/org data object

  // ── Phase 3 globals ──
  var myWaId = null; // Own WhatsApp ID (from WPP.conn.getMyUserId())
  var orgId = null; // Current organization UUID
  var baseUrl = null; // API base URL (from content.js or hardcoded)
  var refreshTimer = null; // Auto-refresh interval ID
  var filterPersistTimer = null; // Debounce timer for MutationObserver
  var dataLoaded = false; // True after first successful data load
  var chatListObserver = null; // MutationObserver instance for filter persistence
  var paneSideRecoveryObserver = null; // Observer 2: #side watcher (created once)
  // var chatNameToId = {}; // REMOVED — no longer matching DOM→ID (we own the DOM)

  // ── Virtual scroll globals (Kraya-style) ──
  // var nativeRowCache = {}; // REMOVED — replaced by live model rendering (buildChatRowHTML)
  var paneSideEl = null; // Cached #pane-side element (our clone when filtering)
  var scrollContainerEl = null; // The actual scrollable viewport (chatListEl.parentElement)
  var currentFilteredIds = []; // Ordered chat IDs for current filter
  var renderedRows = {}; // renderedRows[chatId] = DOM element currently in chat-list
  var waOriginalPaneSide = null; // WA's hidden original #pane-side element
  var isOcrmControllingChatList = false; // True when our clone replaces WA's pane-side

  // ── New: Kraya-style live model storage ──
  var liveChatModels = []; // Sorted array of live WPP Backbone chat models
  var liveChatMap = {}; // liveChatMap[chatId_serialized] = live model reference
  var rowCache = {}; // rowCache[chatId] = jQuery DOM element (our rendered row)
  var isBusinessApp = false; // True if WhatsApp Business (rows are 76px tall)
  var bucketRefreshTimer = null; // 5-second setInterval handle for refreshBuckets()
  var BUCKET_REFRESH_MS = 5000; // 5 seconds — matches Kraya's Tt() interval

  // ── Constants ──
  var REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  var LEAD_PAGE_SIZE = 500; // Leads per API page
  var LEAD_SINCE_DAYS = 365; // Load leads from last N days
  var FILTER_DEBOUNCE_MS = 150; // MutationObserver debounce
  var ROW_HEIGHT = 72; // WA chat row height in px (72 normal, 76 business)
  var VIEWPORT_BUFFER = 0.25; // 25% buffer above/below viewport for pre-rendering

  // Listen for config broadcast from content.js (baseUrl)
  window.addEventListener("OceanCRMConfigEvent", function (event) {
    baseUrl = (event.detail && event.detail.baseUrl) || null;
    console.log("[OceanCRM:MAIN] Received baseUrl: " + baseUrl);
  });

  // ================================================================
  // SECTION 2: CONSTANTS
  // ================================================================

  var FILTER_TABS = [
    { slug: "all-chats", icon: "🗨️", label: "All Chats" },
    { slug: "unread-chats", icon: "📫", label: "Unread" },
    { slug: "needs-reply", icon: "📩", label: "Needs Reply" },
    { slug: "groups", icon: "👥", label: "Groups" },
    { slug: "pending-reminders", icon: "⏳", label: "Pending" },
  ];

  /**
   * CSS selector map per WhatsApp UI version.
   *
   * Usage: $(SELECTORS[uiVersion].app)
   *        $(SELECTORS[uiVersion]["chat-row"])
   *
   * These selectors target WhatsApp's internal DOM structure.
   * They WILL break when WA updates — that's expected.
   * Update the version-specific entries when WA changes classes.
   */
  var SELECTORS = {
    2.3: {
      app: "#app",
      side: "#side",
      "pane-side": "#pane-side",
      "chat-list": '[aria-label="Chat list"]',
      "chat-row": '[role="row"]',
      "chat-node": "._ak72._ak73",
      "search-bar": '[data-testid="chat-list-search"]',
      header: "header",
      "chat-highlight": "._ahlk",
      "syncing-node": "._aigx",
    },
    2.2: {
      app: "#app",
      side: "#side",
      "pane-side": "#pane-side",
      "chat-list": '[aria-label="Chat list"]',
      "chat-row": '[role="listitem"]',
      "chat-node": "._2H6nH._3w5Pa",
      "search-bar": '[data-testid="chat-list-search"]',
      header: "header",
      "chat-highlight": "._2H6nH",
      "syncing-node": "._1WMqh",
    },
  };

  /**
   * HTML template map per WhatsApp UI version.
   *
   * Usage: TEMPLATES[uiVersion]["stage-highlight"]("New Lead", "#ff8d3d")
   *
   * Templates generate HTML strings that blend with WhatsApp's native UI
   * by using WA's internal CSS classes alongside our own `.ocrm-*` classes.
   */
  var TEMPLATES = {
    2.3: {
      "stage-highlight": function (name, color) {
        return (
          '<div class="_ahlk x1rg5ohu xf6vk7d xhslqc4 x16dsc37 xt4ypqs x2b8uid ocrm-chat-stage-status"' +
          ' style="color:' +
          color +
          ";border-color:" +
          color +
          ';">' +
          name +
          "</div>"
        );
      },
      "auto-responder": function () {
        return (
          '<div class="_ahlk x1rg5ohu xf6vk7d xhslqc4 x16dsc37 xt4ypqs x2b8uid ocrm-chat-auto-status"' +
          ' title="Auto-Followup" style="color:#ff9800;border-color:#ff9800;">AF</div>'
        );
      },
      // Kraya equivalent: Ba["2.3"]["chat-node-html"] — full chat row HTML
      "chat-node-html": function (
        offset,
        chatId,
        hasUnread,
        avatarHtml,
        name,
        timeStr,
        lastMsgText,
        readReceiptHtml,
        mediaIconHtml,
        authorName,
        badgesHtml,
      ) {
        return (
          '<div class="x10l6tqk xh8yej3 x1g42fcv" role="row"' +
          ' style="z-index: 7; transition: none; height: ' +
          getRowHeight() +
          "px;" +
          " transform: translateY(" +
          offset +
          'px);"' +
          ' data-chat-id="' +
          chatId +
          '"' +
          ' data-pixel-offset="' +
          offset +
          '">' +
          '<div role="none" class="x1n2onr6" tabindex="0">' +
          '<div tabindex="-1" class="" aria-selected="false">' +
          '<div class="_ak72 _ak73' +
          (hasUnread ? " _ak7n" : "") +
          '">' +
          avatarHtml +
          '<div class="_ak8l">' +
          '<div role="gridcell" aria-colindex="2" class="_ak8o">' +
          '<div class="_ak8q">' +
          '<div class="_aou8 _aj_h">' +
          '<div class="xuxw1ft x6ikm8r x10wlt62 xlyipyv x78zum5">' +
          '<span dir="auto" title="' +
          sanitizeHTML(name) +
          '"' +
          ' class="x1iyjqo2 x6ikm8r x10wlt62 x1n2onr6 xlyipyv xuxw1ft x1rg5ohu x1jchvi3 xjb2p0i xo1l8bm x17mssa0 x1ic7a3i _ao3e"' +
          ' style="min-height: 0px;">' +
          sanitizeHTML(name) +
          "</span>" +
          "</div>" +
          "</div>" +
          "</div>" +
          '<div class="_ak8i xn80e1m">' +
          timeStr +
          "</div>" +
          "</div>" +
          '<div class="_ak8j">' +
          '<div class="_ak8k">' +
          '<span class="x78zum5 x1cy8zhl" title="' +
          sanitizeHTML(lastMsgText) +
          '">' +
          '<span class="status-ack-icon" data-chat-id="' +
          chatId +
          '">' +
          readReceiptHtml +
          "</span>" +
          mediaIconHtml +
          '<div class="x1c4vz4f x3nfvp2 xuce83p x1bft6iq x1i7k8ik xq9mrsl x6s0dn4">' +
          '<div class="x78zum5">' +
          '<span dir="auto" class="x1rg5ohu _ao3e author-name-text"' +
          ' style="min-height: 0px;">' +
          authorName +
          "</span>" +
          "</div>" +
          "</div>" +
          (authorName ? "<span>:&nbsp;</span>" : "") +
          '<span dir="ltr"' +
          ' class="x1iyjqo2 x6ikm8r x10wlt62 x1n2onr6 xlyipyv xuxw1ft x1rg5ohu _ao3e last-message-text"' +
          ' style="min-height: 0px;">' +
          sanitizeHTML(lastMsgText) +
          "</span>" +
          "</span>" +
          "</div>" +
          '<div role="gridcell" aria-colindex="1" class="_ak8i">' +
          '<span class="">' +
          badgesHtml +
          "</span>" +
          '<span class=""></span>' +
          '<span class=""></span>' +
          "</div>" +
          "</div>" +
          "</div>" +
          "</div></div></div></div>"
        );
      },
      // Kraya equivalent: unread count badge for v2.3
      "chat-unread-badge": function (count) {
        return (
          '<div class="_ahlk x1rg5ohu xf6vk7d xhslqc4 x16dsc37 xt4ypqs x2b8uid">' +
          '<span class="x1rg5ohu x1gxa6cn x1j8ymqv xa0aww2 x4tra6z x1pse0pq x16dsc37' +
          ' xlup9mm x15kz4h8 x2b8uid xt8t1vi x1xc408v x129tdwq x15urzxu xyp3urf"' +
          ' aria-label="' +
          count +
          ' unread messages">' +
          '<span class="x140p0ai x1gufx9m x1s928wv xhkezso x1gmr53x x1cpjm7i' +
          " x1fgarty x1943h6x x193iq5w xeuugli x1vvkbs x1lliihq x1fj9vlw x1pse0pq" +
          ' xdnwjd9 x1pg5gke xjb2p0i xfjzk2p xl2ypbo x1ic7a3i">' +
          count +
          "</span></span></div>"
        );
      },
    },
    2.2: {
      "stage-highlight": function (name, color) {
        return (
          '<div class="_2H6nH _3w5Pa ocrm-chat-stage-status"' +
          ' style="color:' +
          color +
          ";border-color:" +
          color +
          ';">' +
          name +
          "</div>"
        );
      },
      "auto-responder": function () {
        return (
          '<div class="_2H6nH _3w5Pa ocrm-chat-auto-status"' +
          ' title="Auto-Followup" style="color:#ff9800;border-color:#ff9800;">AF</div>'
        );
      },
      // Kraya equivalent: Ba["2.2"]["chat-node-html"] — full chat row HTML
      "chat-node-html": function (
        offset,
        chatId,
        hasUnread,
        avatarHtml,
        name,
        timeStr,
        lastMsgText,
        readReceiptHtml,
        mediaIconHtml,
        authorName,
        badgesHtml,
      ) {
        return (
          '<div class="lhggkp7q ln8gz9je rx9719la" role="listitem"' +
          ' style="z-index: 490; transition: none 0s ease 0s; height: 72px;' +
          " transform: translateY(" +
          offset +
          'px);"' +
          ' data-chat-id="' +
          chatId +
          '"' +
          ' data-pixel-offset="' +
          offset +
          '">' +
          '<div class="g0rxnol2">' +
          '<div tabindex="-1" class="" aria-selected="false" role="row">' +
          '<div class="_199zF _3j691' +
          (hasUnread ? " _1KV7I" : "") +
          '">' +
          avatarHtml +
          '<div class="_8nE1Y">' +
          '<div role="gridcell" aria-colindex="2" class="y_sn4">' +
          '<div class="_21S-L">' +
          '<div class="Mk0Bp _30scZ">' +
          '<span dir="auto" title="' +
          sanitizeHTML(name) +
          '" aria-label=""' +
          ' class="ggj6brxn gfz4du6o r7fjleex g0rxnol2 lhj4utae le5p0ye3 l7jjieqr _11JPr"' +
          ' style="min-height: 0px;">' +
          sanitizeHTML(name) +
          "</span>" +
          "</div>" +
          "</div>" +
          '<div class="Dvjym"><span class="aprpv14t">' +
          timeStr +
          "</span></div>" +
          "</div>" +
          '<div class="_2KKXC">' +
          '<div class="vQ0w7">' +
          '<span class="p357zi0d r15c9g6i" title="' +
          sanitizeHTML(lastMsgText) +
          '">' +
          readReceiptHtml +
          '<div class="Mk0Bp _30scZ">' +
          '<span dir="auto" aria-label="" class="l7jjieqr _11JPr author-name-text"' +
          ' style="min-height: 0px;">' +
          authorName +
          "</span>" +
          "</div>" +
          (authorName ? "<span>:&nbsp;</span>" : "") +
          mediaIconHtml +
          '<span dir="ltr" aria-label=""' +
          ' class="ggj6brxn gfz4du6o r7fjleex g0rxnol2 lhj4utae le5p0ye3 l7jjieqr _11JPr last-message-text"' +
          ' style="min-height: 0px;">' +
          sanitizeHTML(lastMsgText) +
          "</span>" +
          "</span>" +
          "</div>" +
          '<div role="gridcell" aria-colindex="1" class="Dvjym">' +
          '<span class="">' +
          badgesHtml +
          "</span>" +
          '<span class=""></span>' +
          '<span class=""></span>' +
          "</div>" +
          "</div>" +
          "</div>" +
          "</div></div></div></div>"
        );
      },
      // Kraya equivalent: unread count badge for v2.2
      "chat-unread-badge": function (count) {
        return (
          '<div class="_2H6nH"><span class="l7jjieqr cfzgl7ar ei5e7seu h0viaqh7' +
          " tpmajp1w c0uhu3dl riy2oczp dsh4tgtl sy6s5v3r gz7w46tb lyutrhe2" +
          ' qfejxiq4 fewfhwl7 ovhn1urg ap18qm3b ikwl5qvt j90th5db aumms1qt"' +
          ' aria-label="Unread">' +
          count +
          "</span></div>"
        );
      },
    },
  };

  // ================================================================
  // SECTION 3: WA VERSION DETECTION
  // ================================================================

  /**
   * Detect WhatsApp's UI version by checking WPP internals or DOM classes.
   * Sets the global `uiVersion` variable.
   *
   * Detection strategy (ordered by reliability):
   *   1. WPP.whatsapp.contants.SANITIZED_VERSION_STR (if available)
   *   2. DOM class heuristic: check for known 2.2-era class names
   *   3. Default to "2.3"
   */
  function detectWAVersion() {
    try {
      // Method 1: WPP internal version string
      if (
        window.WPP &&
        window.WPP.whatsapp &&
        window.WPP.whatsapp.contants &&
        window.WPP.whatsapp.contants.SANITIZED_VERSION_STR
      ) {
        var ver = WPP.whatsapp.contants.SANITIZED_VERSION_STR;
        uiVersion = ver.startsWith("2.2") ? "2.2" : "2.3";
        console.log(
          "[OceanCRM:MAIN] WA version detected via WPP: " +
            uiVersion +
            " (raw: " +
            ver +
            ")",
        );
        return uiVersion;
      }

      // Method 2: DOM heuristic — look for 2.2-era chat list class
      if (document.querySelector('[role="listitem"]._2H6nH')) {
        uiVersion = "2.2";
        console.log(
          "[OceanCRM:MAIN] WA version detected via DOM heuristic: 2.2",
        );
        return uiVersion;
      }

      // Default
      console.log("[OceanCRM:MAIN] WA version defaulting to: " + uiVersion);
      return uiVersion;
    } catch (e) {
      console.warn(
        "[OceanCRM:MAIN] Version detection error, using default:",
        e,
      );
      return uiVersion;
    }
  }

  // ================================================================
  // SECTION 4: NAVBAR RENDERING (jQuery)
  // ================================================================

  /**
   * Render the full OceanCRM navbar and inject it into WhatsApp's DOM.
   *
   * The navbar is prepended to the parent of #app, pushing WA content down.
   * After injection, event handlers are bound and layout is adjusted.
   *
   * Kraya equivalent: pr() (main-bundle.min.js line 9066)
   *
   * @param {object} options
   * @param {Array}  options.stages  - Pipeline stages from API (may be empty initially)
   * @param {object} options.buckets - Filter/stage buckets: { slug: [chatIds] }
   * @param {string} options.version - Extension version string (e.g., "1.2.0")
   */
  function renderNavbar(options) {
    var opts = options || {};
    var stagesData = opts.stages || [];
    var bucketsData = opts.buckets || {};
    var version = opts.version || "1.2.0";

    // Remove existing navbar if re-rendering
    $("#ocrm-navbar").remove();

    // ── Build HTML ──
    var html = '<div id="ocrm-navbar" class="ocrm-navbar">';

    // Layer 1: Warning banners placeholder (hidden by default)
    html += '<div id="ocrm-warnings"></div>';

    // Layer 2: Main navbar
    html += '<div class="ocrm-main-navbar">';

    // Left side: Logo + Filter Tabs
    html += '  <div class="ocrm-lhs-navbar">';
    html += '    <div class="ocrm-logo">';
    html += '      <span class="ocrm-logo-text">OceanCRM</span>';
    html += '      <span class="ocrm-version-badge">v' + version + "</span>";
    html += "    </div>";
    html += '    <div id="ocrm-filter-tabs" class="ocrm-filter-tabs">';
    html += renderFilterTabsHTML(bucketsData);
    html += "    </div>";
    html += "  </div>";

    // Right side: Action buttons
    html += '  <div class="ocrm-navbar-actions">';
    html +=
      '    <button id="ocrm-dashboard-btn" class="ocrm-navbar-btn" title="Open Dashboard">';
    html += '      🌐 <span class="ocrm-btn-label">Dashboard</span>';
    html += "    </button>";
    html +=
      '    <button id="ocrm-settings-btn" class="ocrm-navbar-btn" title="Settings">';
    html += "      ⚙️";
    html += "    </button>";
    html +=
      '    <button id="ocrm-login-btn" class="ocrm-navbar-btn primary" title="Login">';
    html += '      🔐 <span class="ocrm-btn-label">Login</span>';
    html += "    </button>";
    html += "  </div>";

    html += "</div>"; // .ocrm-main-navbar

    // Layer 3: Stage pipeline navbar
    html += '<div class="ocrm-stage-navbar">';
    html +=
      '  <button id="ocrm-scroll-left" class="ocrm-stage-scroll-btn" title="Scroll left">';
    html += "    ◀";
    html += "  </button>";
    html += '  <div class="ocrm-stage-tabs-wrapper">';
    html += '    <div id="ocrm-stage-tabs" class="ocrm-stage-tabs">';
    html += renderStageTabsHTML(stagesData, bucketsData);
    html += "    </div>";
    html += "  </div>";
    html +=
      '  <button id="ocrm-scroll-right" class="ocrm-stage-scroll-btn" title="Scroll right">';
    html += "    ▶";
    html += "  </button>";
    html += "</div>"; // .ocrm-stage-navbar

    html += "</div>"; // .ocrm-navbar

    // ── Inject into DOM ──
    var $app = $(SELECTORS[uiVersion].app);
    if ($app.length === 0) {
      console.error(
        "[OceanCRM:MAIN] Cannot find #app element to inject navbar",
      );
      return;
    }
    $app.parent().prepend($(html));

    // ── Bind event handlers ──
    bindNavbarEvents();

    // ── Adjust WA layout to make room for navbar ──
    adjustLayout();

    // ── Initialize scroll button visibility ──
    updateScrollButtonVisibility();

    console.log("[OceanCRM:MAIN] Navbar rendered");
  }

  /**
   * Generate HTML for filter tabs.
   *
   * @param {object} bucketsData - { slug: [chatIds] } — may be empty during initial render
   * @returns {string} HTML string of filter tab buttons
   */
  function renderFilterTabsHTML(bucketsData) {
    var html = "";
    for (var i = 0; i < FILTER_TABS.length; i++) {
      var tab = FILTER_TABS[i];
      var count = (bucketsData[tab.slug] && bucketsData[tab.slug].length) || 0;
      var isActive = activeFilter === tab.slug ? " active-tab" : "";

      html += '<button class="ocrm-filter-tab' + isActive + '"';
      html += ' data-tab="' + tab.slug + '"';
      html += ' id="' + tab.slug + '_btn">';
      html += '  <span class="ocrm-filter-tab-icon">' + tab.icon + "</span>";
      html +=
        '  <span class="ocrm-filter-tab-label">' +
        tab.label +
        " (" +
        count +
        ")</span>";
      html += "</button>";
    }
    return html;
  }

  /**
   * Re-render just the filter tabs (e.g., after bucket data changes).
   * Preserves the active tab state.
   */
  function renderFilterTabs() {
    var $container = $("#ocrm-filter-tabs");
    if ($container.length === 0) return;

    $container.html(renderFilterTabsHTML(buckets));
  }

  /**
   * Generate HTML for stage pipeline tabs (colored arrow chevrons).
   *
   * @param {Array}  stagesData  - Array of stage objects: [{id, stage, slug, order, color, is_default}]
   * @param {object} bucketsData - { slug: [chatIds] }
   * @returns {string} HTML string of stage tab elements
   *
   * Kraya equivalent: Part of Pr() (main-bundle.min.js line 9528)
   */
  function renderStageTabsHTML(stagesData, bucketsData) {
    var html = "";
    var visibleIndex = 0;

    for (var i = 0; i < stagesData.length; i++) {
      var stage = stagesData[i];

      // Skip default/system stages (they're represented by filter tabs)
      if (stage.is_default) continue;

      var count =
        (bucketsData[stage.slug] && bucketsData[stage.slug].length) || 0;
      var isActive = activeFilter === stage.slug ? " active-tab" : "";
      var displayName = stage.stage || "Unknown";

      // Truncate long names
      var truncatedName =
        displayName.length > 20
          ? displayName.substring(0, 18) + "…"
          : displayName;

      // Z-index descending so arrow overlaps correctly (leftmost on top)
      var zIndex = stagesData.length - visibleIndex;

      html += '<div class="ocrm-stage-tab-cont' + isActive + '"';
      html += ' data-tab-name="' + stage.slug + '"';
      html += ' data-stage-id="' + stage.id + '"';
      html += ' id="' + stage.slug + '_btn"';
      html += ' style="z-index:' + zIndex + ';"';
      html += ' title="' + displayName + " (" + count + ')">';

      // Tooltip (accessible on hover via CSS)
      html += '  <div class="ocrm-stage-tooltip">' + displayName + "</div>";

      // Count
      html += '  <span class="ocrm-stage-tab-count">' + count + "</span>";

      // Name
      html +=
        '  <span class="ocrm-stage-tab-name">' + truncatedName + "</span>";

      html += "</div>";

      visibleIndex++;
    }

    return html;
  }

  /**
   * Re-render just the stage tabs (e.g., after stages reload or pipeline change).
   * Preserves active tab state.
   *
   * Kraya equivalent: Pr() (main-bundle.min.js line 9528)
   */
  function renderStageTabs() {
    var $container = $("#ocrm-stage-tabs");
    if ($container.length === 0) return;

    $container.html(renderStageTabsHTML(stages, buckets));

    // Update scroll button visibility
    updateScrollButtonVisibility();
  }

  /**
   * Bind all navbar event handlers using jQuery event delegation.
   *
   * Event delegation (document.body) ensures handlers survive DOM changes.
   * Kraya uses the same pattern: $(document.body).on("click", selector, handler)
   */
  function bindNavbarEvents() {
    // Filter tab clicks
    $(document.body).on(
      "click",
      "#ocrm-filter-tabs .ocrm-filter-tab",
      onFilterTabClick,
    );

    // Stage tab clicks
    $(document.body).on(
      "click",
      "#ocrm-stage-tabs .ocrm-stage-tab-cont",
      onStageTabClick,
    );

    // Scroll buttons
    $("#ocrm-scroll-left").on("click", function () {
      scrollStageTabs("left");
    });
    $("#ocrm-scroll-right").on("click", function () {
      scrollStageTabs("right");
    });

    // Dashboard button
    $(document.body).on("click", "#ocrm-dashboard-btn", function () {
      window.open("https://app.oceancrm.in", "_blank");
    });

    // Warning banner close buttons
    $(document.body).on("click", ".ocrm-banner-close", function () {
      $(this)
        .closest(".ocrm-warning-banner")
        .slideUp(200, function () {
          adjustLayout(); // Recalculate after banner collapses
        });
    });

    // Login button (dispatches event for content.js to handle)
    $(document.body).on("click", "#ocrm-login-btn", function () {
      window.dispatchEvent(
        new CustomEvent("OceanCRMLoginRequestEvent", { detail: {} }),
      );
    });

    // Stage tabs scroll → update gradient visibility
    $("#ocrm-stage-tabs").on("scroll", function () {
      updateScrollButtonVisibility();
    });
  }

  /**
   * Adjust WhatsApp's #app position to accommodate the navbar.
   *
   * The navbar is position:fixed at the top. We push #app down by setting
   * its `top` CSS property and reducing its height accordingly.
   *
   * Kraya equivalent: jr() (main-bundle.min.js line 9631)
   *
   * Called:
   *   - After renderNavbar()
   *   - After warning banner show/hide
   *   - After filter tab click (if layout shifted)
   *   - On window resize
   */
  function adjustLayout() {
    var $navbar = $("#ocrm-navbar");
    var $app = $(SELECTORS[uiVersion].app);
    if ($navbar.length === 0 || $app.length === 0) return;

    var navbarHeight = $navbar.outerHeight();

    $app.css({
      position: "relative",
      top: navbarHeight + "px",
      height: "calc(100% - " + navbarHeight + "px)",
    });

    // Also update the navbar width to match #app's parent width
    var parentWidth = $app.parent().width();
    $navbar.css("width", parentWidth + "px");
  }

  // ================================================================
  // SECTION 5: EVENT HANDLERS
  // ================================================================

  /**
   * Handle filter tab click.
   *
   * Kraya equivalent: Vr() (main-bundle.min.js line 9479)
   *
   * Flow:
   *   1. Determine which tab was clicked (data-tab attribute)
   *   2. Update activeFilter global
   *   3. Toggle active-tab CSS classes (filter AND stage tabs)
   *   4. Trigger chat list rebuild (Phase 3 — stubbed here)
   *   5. Refresh tab counts
   *
   * @param {Event} event - jQuery click event
   */
  function onFilterTabClick(event) {
    var $btn = $(event.target).closest(".ocrm-filter-tab");
    if ($btn.length === 0) return;

    var tabName = $btn.data("tab");
    if (!tabName) return;

    // Update global state
    activeFilter = tabName;

    // Update filter tab active states
    $("#ocrm-filter-tabs .ocrm-filter-tab").removeClass("active-tab");
    $btn.addClass("active-tab");

    // Deselect any active stage tab
    $(".ocrm-stage-tab-cont").removeClass("active-tab");

    // Trigger chat list filtering (Phase 3 will implement rebuildChatList)
    if (typeof rebuildChatList === "function") {
      rebuildChatList(tabName);
    }

    // Refresh counts
    updateTabCounts();

    // Recalculate layout (in case content shifted)
    adjustLayout();

    console.log("[OceanCRM:MAIN] Filter tab clicked: " + tabName);
  }

  /**
   * Handle stage tab click.
   *
   * Kraya equivalent: Zr() (main-bundle.min.js line 9501)
   *
   * Flow:
   *   1. Determine which stage was clicked (data-tab-name attribute)
   *   2. Check if user is logged in (if not, prompt login)
   *   3. Update activeFilter global
   *   4. Toggle active-tab CSS classes (stage AND filter tabs)
   *   5. Trigger chat list rebuild (Phase 3)
   *   6. Refresh tab counts
   *
   * @param {Event} event - jQuery click event
   */
  function onStageTabClick(event) {
    var $tab = $(event.target).closest(".ocrm-stage-tab-cont");
    if ($tab.length === 0) return;

    var tabName = $tab.data("tab-name");
    if (!tabName) return;

    // Check login state — stage filtering requires auth
    if (!isLoggedIn) {
      window.dispatchEvent(
        new CustomEvent("OceanCRMLoginRequestEvent", { detail: {} }),
      );
      console.log("[OceanCRM:MAIN] Stage tab click blocked — not logged in");
      return;
    }

    // Toggle behavior: clicking the same active tab deselects it → show all
    if (activeFilter === tabName) {
      activeFilter = "all-chats";
      $tab.removeClass("active-tab");
      // Activate "All Chats" filter tab
      $('#ocrm-filter-tabs .ocrm-filter-tab[data-tab="all-chats"]').addClass(
        "active-tab",
      );
    } else {
      // Update global state
      activeFilter = tabName;

      // Update stage tab active states
      $(".ocrm-stage-tab-cont").removeClass("active-tab");
      $tab.addClass("active-tab");

      // Deselect any active filter tab
      $("#ocrm-filter-tabs .ocrm-filter-tab").removeClass("active-tab");
    }

    // Trigger chat list filtering (Phase 3)
    if (typeof rebuildChatList === "function") {
      rebuildChatList(activeFilter);
    }

    // Refresh counts
    updateTabCounts();

    console.log(
      "[OceanCRM:MAIN] Stage tab clicked: " +
        tabName +
        " → activeFilter: " +
        activeFilter,
    );
  }

  /**
   * Scroll the stage tabs container left or right.
   *
   * Kraya equivalent: hr() (main-bundle.min.js line 9200)
   *
   * @param {string} direction - "left" or "right"
   */
  function scrollStageTabs(direction) {
    var $container = $("#ocrm-stage-tabs");
    if ($container.length === 0) return;

    var currentScroll = $container.scrollLeft();
    var maxScroll = $container[0].scrollWidth - $container.outerWidth();

    // Scroll by 40% of viewport width
    var delta = Math.ceil(0.4 * window.innerWidth);
    if (direction === "left") delta = -delta;

    var newScroll = currentScroll + delta;
    newScroll = Math.max(0, Math.min(newScroll, maxScroll));

    $container.animate({ scrollLeft: newScroll }, 500, function () {
      updateScrollButtonVisibility();
    });
  }

  /**
   * Show/hide scroll buttons and gradient overlays based on scroll position.
   *
   * - Left button/gradient hidden when scrolled to start
   * - Right button/gradient hidden when scrolled to end
   * - Both hidden if content fits without scrolling
   *
   * Kraya equivalent: Part of jr() (main-bundle.min.js line 9631)
   */
  function updateScrollButtonVisibility() {
    var $container = $("#ocrm-stage-tabs");
    var $wrapper = $(".ocrm-stage-tabs-wrapper");
    if ($container.length === 0) return;

    var scrollLeft = $container.scrollLeft();
    var maxScroll = $container[0].scrollWidth - $container.outerWidth();
    var canScroll = maxScroll > 5; // 5px threshold to avoid float errors

    var $leftBtn = $("#ocrm-scroll-left");
    var $rightBtn = $("#ocrm-scroll-right");

    if (!canScroll) {
      // All tabs fit — hide both buttons
      $leftBtn.hide();
      $rightBtn.hide();
      $wrapper.removeClass("can-scroll-left can-scroll-right");
      return;
    }

    // Left button
    if (scrollLeft <= 5) {
      $leftBtn.css("opacity", "0.3");
      $wrapper.removeClass("can-scroll-left");
    } else {
      $leftBtn.css("opacity", "1");
      $wrapper.addClass("can-scroll-left");
    }

    // Right button
    if (scrollLeft >= maxScroll - 5) {
      $rightBtn.css("opacity", "0.3");
      $wrapper.removeClass("can-scroll-right");
    } else {
      $rightBtn.css("opacity", "1");
      $wrapper.addClass("can-scroll-right");
    }

    $leftBtn.show();
    $rightBtn.show();
  }

  /**
   * Update all tab count displays from current bucket data.
   *
   * Kraya equivalent: Dr() (main-bundle.min.js line 9601)
   *
   * Two types of tabs to update:
   *   1. Filter tabs: Update the "(N)" text in the label
   *   2. Stage tabs: Update the count number and tooltip
   */
  function updateTabCounts() {
    // ── Update filter tabs ──
    for (var i = 0; i < FILTER_TABS.length; i++) {
      var tab = FILTER_TABS[i];
      var count = (buckets[tab.slug] && buckets[tab.slug].length) || 0;
      var $btn = $("#" + tab.slug + "_btn");
      if ($btn.length > 0) {
        $btn
          .find(".ocrm-filter-tab-label")
          .text(tab.label + " (" + count + ")");
      }
    }

    // ── Update stage tabs ──
    var nonDefaultStages = stages.filter(function (s) {
      return !s.is_default;
    });
    for (var j = 0; j < nonDefaultStages.length; j++) {
      var stage = nonDefaultStages[j];
      var stageCount = (buckets[stage.slug] && buckets[stage.slug].length) || 0;
      var $stageBtn = $("#" + stage.slug + "_btn");
      if ($stageBtn.length > 0) {
        $stageBtn.find(".ocrm-stage-tab-count").text(stageCount);
        $stageBtn.attr("title", stage.stage + " (" + stageCount + ")");
        $stageBtn
          .find(".ocrm-stage-tooltip")
          .text(stage.stage + " (" + stageCount + ")");
      }
    }
  }

  // ================================================================
  // SECTION 6: UTILITY FUNCTIONS
  // ================================================================

  /**
   * Get the color for a stage based on its position in the stages array.
   * Used for chat badges (Phase 4) where we need the color value in JS.
   *
   * @param {string} slug - Stage slug
   * @returns {string} CSS color value (raw hex)
   */
  function getStageColor(slug) {
    var RAW_COLORS = [
      "#e74c3c",
      "#ff8d3d",
      "#398bcd",
      "#ae76ae",
      "#62bb6a",
      "#f15854",
      "#48b2cf",
      "#eaae28",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#f97316",
    ];

    var nonDefaultStages = stages.filter(function (s) {
      return !s.is_default;
    });
    for (var i = 0; i < nonDefaultStages.length; i++) {
      if (nonDefaultStages[i].slug === slug) {
        return RAW_COLORS[i % 12];
      }
    }
    return RAW_COLORS[0]; // fallback
  }

  /**
   * Convert a stage name to a URL-safe slug.
   *
   * Examples:
   *   "RAW (UNQUALIFIED)" → "raw-unqualified"
   *   "NEW"               → "new"
   *   "In Conversation"   → "in-conversation"
   *   "Lead Won!"         → "lead-won"
   *
   * @param {string} name - Stage name from API
   * @returns {string} Slugified string
   */
  function slugify(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-") // Replace non-alphanumeric with hyphens
      .replace(/^-+|-+$/g, ""); // Trim leading/trailing hyphens
  }

  /**
   * Normalize a phone number to WhatsApp chat ID format.
   *
   * Input examples:
   *   "+91 98765 43210" → "919876543210@c.us"
   *   "919876543210"    → "919876543210@c.us"
   *   "09876543210"     → "9876543210@c.us"
   *
   * Enrich raw API stages with slug, color, and is_default flag.
   *
   * OceanCRM's API returns: [{ stage: "NEW", order: 1 }, ...]
   * We need:                [{ stage: "NEW", slug: "new", order: 1,
   *                            color: "#ff8d3d", is_default: false }, ...]
   *
   * Stages at order 0 ("RAW (UNQUALIFIED)") are treated as the default/system stage.
   *
   * @param {Array} rawStages - Array from GET /v1/lead/stage/
   * @returns {Array} Enriched stage objects
   */
  function enrichStages(rawStages) {
    var RAW_COLORS = [
      "#e74c3c",
      "#ff8d3d",
      "#398bcd",
      "#ae76ae",
      "#62bb6a",
      "#f15854",
      "#48b2cf",
      "#eaae28",
      "#8b5cf6",
      "#ec4899",
      "#14b8a6",
      "#f97316",
    ];

    // Sort by order to ensure consistent color assignment
    var sorted = rawStages.slice().sort(function (a, b) {
      return a.order - b.order;
    });

    var colorIndex = 0;
    return sorted.map(function (s) {
      var slug = slugify(s.stage);
      var isDefault = s.order === 0; // "RAW (UNQUALIFIED)" at order 0

      var color = RAW_COLORS[colorIndex % RAW_COLORS.length];
      colorIndex++;

      return {
        stage: s.stage,
        slug: slug,
        order: s.order,
        color: color,
        is_default: isDefault,
      };
    });
  }

  // ================================================================
  // SECTION 7: API HELPERS (Promise wrappers for CustomEvent bridge)
  // ================================================================

  /**
   * Generic helper: dispatch a request event and return a Promise
   * that resolves when the corresponding response event fires.
   *
   * @param {string} requestEventName  - e.g., "OceanCRMPingAuthRequestEvent"
   * @param {string} responseEventName - e.g., "OceanCRMPingAuthResponseEvent"
   * @param {object} detail            - Event detail payload
   * @param {number} timeoutMs         - Timeout in ms (default: 15000)
   * @returns {Promise<object>}        - Resolves with response detail
   */
  function apiRequest(requestEventName, responseEventName, detail, timeoutMs) {
    if (timeoutMs === undefined) timeoutMs = 15000;

    return new Promise(function (resolve, reject) {
      var timer = null;

      function handler(event) {
        clearTimeout(timer);
        window.removeEventListener(responseEventName, handler);

        var resp = event.detail || {};
        if (resp.ok === false) {
          reject(new Error(resp.error || "API request failed"));
        } else {
          resolve(resp);
        }
      }

      window.addEventListener(responseEventName, handler);

      timer = setTimeout(function () {
        window.removeEventListener(responseEventName, handler);
        reject(new Error("Timeout waiting for " + responseEventName));
      }, timeoutMs);

      window.dispatchEvent(
        new CustomEvent(requestEventName, { detail: detail || {} }),
      );
    });
  }

  /**
   * Ping auth — check if the user is logged in.
   * @returns {Promise<object>} User data if logged in
   */
  function pingAuth() {
    return apiRequest(
      "OceanCRMPingAuthRequestEvent",
      "OceanCRMPingAuthResponseEvent",
      { baseUrl: baseUrl },
    );
  }

  /**
   * Fetch organizations list.
   * @returns {Promise<Array>} Array of org objects [{id, name}]
   */
  function fetchOrgs() {
    return apiRequest(
      "OceanCRMGetOrgsRequestEvent",
      "OceanCRMGetOrgsResponseEvent",
      { baseUrl: baseUrl },
    ).then(function (resp) {
      return resp.data || [];
    });
  }

  /**
   * Fetch pipeline stages for an organization.
   * @param {string} orgIdParam - Organization UUID
   * @returns {Promise<Array>} Array of stage objects [{stage, order}]
   */
  function fetchStages(orgIdParam) {
    return apiRequest(
      "OceanCRMGetStagesRequestEvent",
      "OceanCRMGetStagesResponseEvent",
      { baseUrl: baseUrl, orgId: orgIdParam },
    ).then(function (resp) {
      return resp.data || [];
    });
  }

  /**
   * Fetch a single page of leads.
   * @param {string} orgIdParam  - Organization UUID
   * @param {number} page        - Page number (1-based)
   * @param {number} pageSize    - Items per page
   * @param {string} since       - ISO date string for the `since` parameter
   * @returns {Promise<object>}  - { items, page, page_size, total, total_pages }
   */
  function fetchLeadsPage(orgIdParam, page, pageSize, since) {
    return apiRequest(
      "OceanCRMFetchLeadsRequestEvent",
      "OceanCRMFetchLeadsResponseEvent",
      {
        baseUrl: baseUrl,
        orgId: orgIdParam,
        page: page,
        pageSize: pageSize,
        since: since,
      },
      30000, // 30s timeout for large pages
    ).then(function (resp) {
      return resp.data || { items: [], page: 1, total_pages: 1 };
    });
  }

  /**
   * Create a new lead.
   * @param {string} orgIdParam - Organization UUID
   * @param {object} leadData   - CreateLead payload
   * @returns {Promise<object>} - Created lead response
   */
  function createLead(orgIdParam, leadData) {
    return apiRequest(
      "OceanCRMCreateLeadRequestEvent",
      "OceanCRMCreateLeadResponseEvent",
      { baseUrl: baseUrl, orgId: orgIdParam, lead: leadData },
    ).then(function (resp) {
      return resp.data;
    });
  }

  /**
   * Update an existing lead.
   * @param {string} orgIdParam - Organization UUID
   * @param {string} leadId     - Lead UUID
   * @param {object} leadData   - UpdateLead payload
   * @returns {Promise<object>} - Updated lead response
   */
  function updateLead(orgIdParam, leadId, leadData) {
    return apiRequest(
      "OceanCRMUpdateLeadRequestEvent",
      "OceanCRMUpdateLeadResponseEvent",
      { baseUrl: baseUrl, orgId: orgIdParam, leadId: leadId, lead: leadData },
    ).then(function (resp) {
      return resp.data;
    });
  }

  // ================================================================
  // SECTION 7B: DATA LOADING
  // ================================================================

  /**
   * Load all CRM leads via paginated API calls.
   *
   * Populates the `leads` map: leads[chatId] = leadObject.
   *
   * The lead's chat ID is determined by:
   *   1. lead.wa_chat_id if present (e.g., "919876543210@c.us")
   *   2. Normalized business.mobile if wa_chat_id is null
   *
   * Leads without a valid chat ID are counted as orphaned (no WA chat row
   * to show, but still counted in stage buckets).
   *
   * @param {string} orgIdParam - Organization UUID
   * @returns {Promise<{loaded: number, orphaned: number}>}
   */
  async function loadAllLeads(orgIdParam) {
    // Calculate "since" date (365 days ago)
    var sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - LEAD_SINCE_DAYS);
    var sinceISO = sinceDate.toISOString();

    // Reset leads map
    leads = {};
    var orphanedCount = 0;
    var totalLoaded = 0;
    var page = 1;
    var hasMore = true;

    console.log(
      "[OceanCRM:MAIN] Starting lead loading (since: " + sinceISO + ")",
    );

    while (hasMore) {
      try {
        var response = await fetchLeadsPage(
          orgIdParam,
          page,
          LEAD_PAGE_SIZE,
          sinceISO,
        );
        var items = response.items || [];

        if (items.length === 0) {
          hasMore = false;
          break;
        }

        // Process each lead
        for (var i = 0; i < items.length; i++) {
          var lead = items[i];

          // Determine chat ID
          var chatId = lead.wa_chat_id || null;
          if (!chatId && lead.business && lead.business.mobile) {
            // Inline phone normalization: strip non-digits, append @c.us
            var digits = String(lead.business.mobile).replace(/\D/g, "");
            if (digits.length >= 7) {
              chatId = digits + "@c.us";
            }
          }

          if (chatId) {
            // Store lead keyed by chat ID, normalized to flat shape
            leads[chatId] = {
              id: lead.id,
              stage: lead.stage,
              stage_slug: slugify(lead.stage),
              wa_chat_id: chatId,
              name: (lead.business && lead.business.name) || "",
              business_name: (lead.business && lead.business.business) || "",
              phone: (lead.business && lead.business.mobile) || "",
              email: (lead.business && lead.business.email) || "",
              potential: lead.potential || 0,
              tags: lead.tags ? Array.from(lead.tags) : [],
              since: lead.since,
              assigned_user: lead.assigned_user || null,
              product: lead.product || null,
              source: lead.source || null,
              notes: lead.notes || "",
              requirements: lead.requirements || "",
            };
            totalLoaded++;
          } else {
            orphanedCount++;
          }
        }

        console.log(
          "[OceanCRM:MAIN] Loaded page " +
            page +
            " (" +
            items.length +
            " items, " +
            totalLoaded +
            " mapped)",
        );

        // Check if there are more pages
        if (page >= (response.total_pages || 1)) {
          hasMore = false;
        } else {
          page++;
        }
      } catch (err) {
        console.error(
          "[OceanCRM:MAIN] Error loading leads page " + page + ":",
          err,
        );
        hasMore = false; // Stop on error, work with what we have
      }
    }

    console.log(
      "[OceanCRM:MAIN] Lead loading complete: " +
        totalLoaded +
        " mapped, " +
        orphanedCount +
        " orphaned (no chat ID)",
    );

    return { loaded: totalLoaded, orphaned: orphanedCount };
  }

  // ================================================================
  // SECTION 7C: BUCKET BUILDING (WPP + CRM merge)
  // ================================================================

  /**
   * Load all WPP chat models as LIVE Backbone references.
   *
   * Unlike the old getWPPChatList() which serialized each chat into a plain
   * object (losing reactivity), this stores direct model references so that
   * Backbone change events, live unreadCount, and live msgs are always current.
   *
   * Kraya equivalent: The chat loading inside zt() + Et()
   *
   * @returns {Promise<Array>} Array of live Backbone chat model objects
   */
  async function loadLiveChatModels() {
    if (!window.WPP || !window.WPP.isReady) {
      throw new Error("WPP not ready");
    }

    var chats = null;

    // Approach 1: WPP.chat.list()
    try {
      chats = await WPP.chat.list();
    } catch (e1) {
      console.warn("[OceanCRM:MAIN] WPP.chat.list() failed:", e1.message);
    }

    // Approach 2: Direct Store access
    if (!chats) {
      try {
        var store =
          window.WPP.whatsapp.ChatStore ||
          (window.WPP.whatsapp.Chat && window.WPP.whatsapp.Chat);
        if (store && store.getModelsArray) {
          chats = store.getModelsArray();
        }
      } catch (e2) {
        console.warn("[OceanCRM:MAIN] Store.Chat fallback failed:", e2.message);
      }
    }

    if (!chats || !chats.length) {
      console.warn("[OceanCRM:MAIN] No chats retrieved from WPP");
      return [];
    }

    // Filter out invalid entries but keep LIVE references (no serialization)
    var valid = [];
    for (var i = 0; i < chats.length; i++) {
      if (chats[i] && chats[i].id && chats[i].id._serialized) {
        valid.push(chats[i]);
      }
    }

    return valid;
  }

  /**
   * Check if a chat has unread messages.
   * Kraya equivalent: Ps() (main-bundle.min.js line 5758)
   *
   * Uses BOTH checks (Kraya does the same):
   *   - unreadCount > 0  (standard counter)
   *   - hasUnread         (edge case: WA marks as unread without count)
   *
   * @param {Object} chat - Live WPP Backbone chat model
   * @returns {boolean}
   */
  function isUnread(chat) {
    return chat.unreadCount > 0 || chat.hasUnread === true;
  }

  /**
   * Get own WhatsApp ID directly from WPP.
   * @returns {string|null} Serialized ID (e.g., "919876543210@c.us")
   */
  function getMyWaId() {
    try {
      if (window.WPP && window.WPP.conn) {
        var myId = WPP.conn.getMyUserId();
        return myId ? myId._serialized : null;
      }
    } catch (e) {
      console.warn("[OceanCRM:MAIN] Error getting own WA ID:", e);
    }
    return null;
  }

  /**
   * Build all filter and stage buckets from LIVE WPP chat models + CRM leads.
   *
   * KEY CHANGE from old approach:
   *   - Old: buckets stored chatId strings; chats were serialized plain objects
   *   - New: buckets store LIVE Backbone model references
   *
   * This means:
   *   - model.unreadCount is always current (live property)
   *   - model.msgs.getModelsArray() returns current messages
   *   - Backbone change events fire on the stored references
   *
   * Kraya equivalent: Tt() (main-bundle.min.js line 1828)
   *
   * @returns {Promise<void>}
   */
  async function buildBuckets() {
    // ── Step 1: Initialize all buckets as empty arrays ──
    buckets = {
      "all-chats": [],
      "unread-chats": [],
      "needs-reply": [],
      groups: [],
      "pending-reminders": [], // Kept as stub — always empty (pending-reminders excluded)
    };

    // Initialize stage buckets
    for (var s = 0; s < stages.length; s++) {
      if (!stages[s].is_default) {
        buckets[stages[s].slug] = [];
      }
    }

    // ── Step 2: Load live chat models ──
    try {
      liveChatModels = await loadLiveChatModels();
    } catch (err) {
      console.error("[OceanCRM:MAIN] Failed to load live chat models:", err);
      liveChatModels = [];
    }

    // ── Step 3: Get own WhatsApp ID ──
    myWaId = myWaId || getMyWaId();

    // ── Step 4: Sort by timestamp (newest first) ──
    liveChatModels.sort(function (a, b) {
      return (b.t || 0) - (a.t || 0);
    });

    // ── Step 5: Build lookup map ──
    liveChatMap = {};
    for (var m = 0; m < liveChatModels.length; m++) {
      var mid = liveChatModels[m].id._serialized;
      liveChatMap[mid] = liveChatModels[m];
    }

    // ── Step 6: Categorize into buckets (using live model references) ──
    for (var i = 0; i < liveChatModels.length; i++) {
      var chat = liveChatModels[i];
      var chatId = chat.id._serialized;

      // Skip archived
      if (chat.archive) continue;

      // All Chats
      buckets["all-chats"].push(chat);

      // Unread — Kraya's Ps(): unreadCount > 0 || hasUnread
      if (isUnread(chat)) {
        buckets["unread-chats"].push(chat);
      }

      // Groups
      if (chat.isGroup) {
        buckets["groups"].push(chat);
      }

      // Needs Reply — last message not from me, has unread, not a group
      if (!chat.isGroup && isUnread(chat)) {
        var msgs =
          chat.msgs && chat.msgs.getModelsArray
            ? chat.msgs.getModelsArray()
            : [];
        if (msgs.length > 0) {
          var lastMsg = msgs[msgs.length - 1];
          if (lastMsg && !lastMsg.id.fromMe) {
            buckets["needs-reply"].push(chat);
          }
        }
      }

      // Stage bucket — from CRM lead data
      var lead = leads[chatId];
      if (lead && lead.stage_slug) {
        if (buckets[lead.stage_slug] === undefined) {
          buckets[lead.stage_slug] = [];
        }
        buckets[lead.stage_slug].push(chat);
      }
    }

    // NOTE: pending-reminders intentionally left empty

    console.log(
      "[OceanCRM:MAIN] Buckets built (live models):",
      summarizeBuckets(),
    );

    // ── Step 7: Update tab counts ──
    updateTabCounts();
  }

  /**
   * Generate a summary string of bucket sizes for logging.
   * @returns {string} e.g., "all-chats:435, unread:39, needs-reply:201, groups:57, new:8"
   */
  function summarizeBuckets() {
    var parts = [];
    for (var key in buckets) {
      if (buckets[key].length > 0) {
        parts.push(key + ":" + buckets[key].length);
      }
    }
    return parts.join(", ");
  }

  /**
   * Render the chat list for the given filter using custom-built rows.
   *
   * Kraya equivalent: Bs() → vs() → fs() chain
   *   Bs() (line 5791): looks up D[tabName], calls vs()
   *   vs() (line 5492): clears chat list, calls Cs() for height, calls fs() for rows
   *   fs() (line 5485): iterates chats, calls ms() for each visible row
   *
   * KEY CHANGE from old approach:
   *   - Old: cloned WA's #pane-side, populated with cloned DOM rows from nativeRowCache
   *   - New: builds custom HTML rows from live WPP model data via buildChatRowHTML()
   *
   * STILL uses the hide-WA + own-pane-side pattern to avoid crashing React.
   * Rows are built from data, not cloned from DOM.
   *
   * @param {string} filterName - Filter or stage slug
   */
  async function rebuildChatList(filterName) {
    if (!filterName) filterName = activeFilter || "all-chats";
    var isAllChats = filterName === "all-chats";

    // ── "All Chats" → restore WA's native control ──
    if (isAllChats) {
      if (isOcrmControllingChatList) {
        restoreNativeChatList();
      }
      $("#ocrm-empty-filter-message").hide();
      return;
    }

    // ── Get filtered chat models from the bucket ──
    var filteredChats = buckets[filterName] || [];

    // Sort: pinned first, then by timestamp (newest first)
    var pinned = [];
    var unpinned = [];
    for (var p = 0; p < filteredChats.length; p++) {
      if (filteredChats[p].pin && filteredChats[p].pin > 0) {
        pinned.push(filteredChats[p]);
      } else {
        unpinned.push(filteredChats[p]);
      }
    }
    unpinned.sort(function (a, b) {
      return (b.t || 0) - (a.t || 0);
    });
    filteredChats = pinned.concat(unpinned);

    // ── Step 1: Take over the chat list (hide WA's, insert our pane) ──
    if (!isOcrmControllingChatList) {
      var waPaneSide = document.getElementById("pane-side");
      if (!waPaneSide) {
        console.warn(
          "[OceanCRM:MAIN] rebuildChatList: #pane-side not found — retrying in 1s",
        );
        setTimeout(function () {
          rebuildChatList(filterName);
        }, 1000);
        return;
      }

      // Disconnect Observer 1 during the swap
      if (chatListObserver) {
        chatListObserver.disconnect();
        chatListObserver = null;
      }

      // Deep-clone #pane-side structure (preserves CSS, header, search bar)
      var ocrmPaneSide = waPaneSide.cloneNode(true);

      // Strip ALL chat rows from the CLONE
      var clonedRows = ocrmPaneSide.querySelectorAll(
        SELECTORS[uiVersion]["chat-row"],
      );
      for (var c = 0; c < clonedRows.length; c++) {
        clonedRows[c].remove();
      }
      // Strip WA's native filter shortcuts from the CLONE
      var clonedShortcuts = ocrmPaneSide.querySelector(
        '[aria-label="chat-list-filters"]',
      );
      if (clonedShortcuts) clonedShortcuts.remove();

      // Hide WA's original (React keeps running)
      waPaneSide.id = "pane-side-wa-backup";
      waPaneSide.style.display = "none";
      waOriginalPaneSide = waPaneSide;

      // Insert our clone
      waPaneSide.parentNode.insertBefore(ocrmPaneSide, waPaneSide);
      paneSideEl = ocrmPaneSide;
      isOcrmControllingChatList = true;

      console.log(
        "[OceanCRM:MAIN] Chat list takeover: clone inserted, WA original hidden",
      );
    }

    // ── Step 2: Get chat list container ──
    var chatListEl = paneSideEl.querySelector(
      SELECTORS[uiVersion]["chat-list"],
    );
    if (!chatListEl) {
      // Also check WA's original pane in case our clone missed it
      var waBackup = document.getElementById("pane-side-wa-backup");
      if (waBackup) {
        chatListEl = waBackup.querySelector(SELECTORS[uiVersion]["chat-list"]);
        if (chatListEl) {
          // Re-clone with the now-populated structure
          isOcrmControllingChatList = false;
          if (paneSideEl && paneSideEl !== waBackup) {
            paneSideEl.parentNode &&
              paneSideEl.parentNode.removeChild(paneSideEl);
          }
          waBackup.id = "pane-side";
          waBackup.style.display = "";
          waOriginalPaneSide = null;
          paneSideEl = waBackup;
          console.warn(
            "[OceanCRM:MAIN] rebuildChatList: reset + retrying with fresh clone in 500ms",
          );
          setTimeout(function () {
            rebuildChatList(filterName);
          }, 500);
          return;
        }
      }
      console.warn(
        "[OceanCRM:MAIN] rebuildChatList: chat-list not found — retrying in 1s",
      );
      setTimeout(function () {
        rebuildChatList(filterName);
      }, 1000);
      return;
    }

    // ── Step 3: Build ordered ID list for virtual scroll ──
    currentFilteredIds = [];
    for (var j = 0; j < filteredChats.length; j++) {
      currentFilteredIds.push(filteredChats[j].id._serialized);
    }

    // ── Step 4: Clear existing rows ──
    var existingRows = chatListEl.querySelectorAll(
      SELECTORS[uiVersion]["chat-row"],
    );
    for (var k = 0; k < existingRows.length; k++) {
      existingRows[k].remove();
    }
    renderedRows = {};
    rowCache = {};

    // ── Step 5: Set container height for scrollbar sizing ──
    //
    // Virtual scroll layout:
    //   scrollContainerEl  (chatListEl.parentElement)
    //     → fixed viewport height, overflow-y: auto  ← scrollbar lives here
    //   chatListEl
    //     → totalHeight px, position: relative        ← creates scroll range
    //   rows
    //     → position: absolute, top = idx * rowH      ← only visible ones exist
    //
    scrollContainerEl = chatListEl.parentElement || paneSideEl;
    // Enable scrolling on the viewport element
    scrollContainerEl.style.overflowY = "auto";
    scrollContainerEl.style.overflowX = "hidden";
    // Disable chatListEl's own overflow so the scrollbar comes from the parent
    chatListEl.style.overflowY = "hidden";

    var rowH = getRowHeight();
    var totalHeight = currentFilteredIds.length * rowH;
    chatListEl.style.position = "relative";
    chatListEl.style.height = totalHeight > 0 ? totalHeight + "px" : "auto";
    chatListEl.setAttribute("aria-rowcount", currentFilteredIds.length);

    // ── Step 6: Render visible rows (virtual scroll) ──
    renderVisibleRows(chatListEl);

    // ── Step 7: Bind scroll handler on the actual scroll viewport ──
    $(scrollContainerEl)
      .off("scroll.ocrm")
      .on("scroll.ocrm", function () {
        renderVisibleRows(chatListEl);
      });

    // ── Step 8: Empty state ──
    var $emptyMsg = $("#ocrm-empty-filter-message");
    if (currentFilteredIds.length === 0) {
      if ($emptyMsg.length === 0) {
        var emptyHTML =
          '<div id="ocrm-empty-filter-message" style="' +
          "text-align:center;padding:40px 20px;color:var(--ocrm-time-color);" +
          'font-size:14px;">No chats in this filter</div>';
        $(chatListEl).append(emptyHTML);
      } else {
        $emptyMsg.show();
      }
    } else {
      $emptyMsg.hide();
    }

    // ── Step 9: Highlight selected chat if visible ──
    if (selectedChat) {
      highlightSelectedChat();
    }

    console.log(
      "[OceanCRM:MAIN] rebuildChatList('" +
        filterName +
        "'): " +
        currentFilteredIds.length +
        " chats rendered",
    );
  }

  /**
   * Render only chat rows visible in the viewport (+ 25% buffer).
   *
   * Kraya equivalent: es() → ss() + rs() (main-bundle.min.js line 5208)
   *
   * KEY CHANGE from old approach:
   *   - Old: getOrBuildRow() → nativeRowCache[chatId].cloneNode(true)
   *   - New: buildChatRowHTML(liveChatMap[chatId], offset) — fresh from live data
   *
   * Each row is positioned absolutely via translateY(offset) within
   * the fixed-height chat-list container.
   *
   * @param {Element} chatListEl - The [aria-label="Chat list"] container
   */
  function renderVisibleRows(chatListEl) {
    if (!paneSideEl || currentFilteredIds.length === 0) return;

    var rowH = getRowHeight();

    // ── Calculate viewport bounds ──
    // scrollContainerEl is chatListEl.parentElement — the actual scrolling viewport.
    // paneSideEl is the outer #pane-side clone which does NOT scroll itself.
    var scrollEl = scrollContainerEl || paneSideEl;
    var scrollTop = scrollEl.scrollTop;
    var clientHeight = scrollEl.clientHeight || paneSideEl.clientHeight;
    var bufferPx = clientHeight * VIEWPORT_BUFFER;
    var viewTop = scrollTop - bufferPx;
    var viewBottom = scrollTop + clientHeight + bufferPx;

    // ── Calculate visible index range ──
    var startIdx = Math.max(0, Math.floor(viewTop / rowH));
    var endIdx = Math.min(
      currentFilteredIds.length - 1,
      Math.ceil(viewBottom / rowH),
    );

    // ── Build set of IDs that SHOULD be rendered ──
    var shouldRender = {};
    for (var i = startIdx; i <= endIdx; i++) {
      shouldRender[currentFilteredIds[i]] = i;
    }

    // ── Remove out-of-viewport rows (recycle) ──
    for (var cid in renderedRows) {
      if (shouldRender[cid] === undefined) {
        if (renderedRows[cid].parentNode) {
          renderedRows[cid].parentNode.removeChild(renderedRows[cid]);
        }
        delete renderedRows[cid];
        delete rowCache[cid];
      }
    }

    // ── Create missing rows from live data ──
    for (var idx = startIdx; idx <= endIdx; idx++) {
      var chatId = currentFilteredIds[idx];
      if (renderedRows[chatId]) continue; // Already rendered

      var chat = liveChatMap[chatId];
      if (!chat) continue; // No model — skip

      var offset = idx * rowH;
      var $row = buildChatRowHTML(chat, offset);

      // Position absolutely
      $row[0].style.position = "absolute";
      $row[0].style.top = "0";
      $row[0].style.left = "0";
      $row[0].style.right = "0";
      $row[0].style.zIndex = "7";
      $row[0].style.transition = "none";
      $row[0].style.display = "";
      $row[0].setAttribute("data-ocrm-idx", idx);

      // Bind click handler
      $row.off("click.ocrm").on("click.ocrm", onChatRowClick);

      chatListEl.appendChild($row[0]);
      renderedRows[chatId] = $row[0];
      rowCache[chatId] = $row;
    }

    // ── Attach Backbone listeners to newly visible chats ──
    // Listeners on models survive even if rows are removed/re-added
    for (var idx2 = startIdx; idx2 <= endIdx; idx2++) {
      var cid2 = currentFilteredIds[idx2];
      var chatModel = liveChatMap[cid2];
      if (!chatModel) continue;

      // Only attach once per model (flag survives virtual scroll recycling)
      if (!chatModel._ocrmListenersBound) {
        chatModel.off("change:msgs.ocrm").on("change:msgs.ocrm", function () {
          onChatChanged(this);
        });
        chatModel
          .off("change:unreadCount.ocrm")
          .on("change:unreadCount.ocrm", async function () {
            onChatChanged(this);
            await rebuildChatList(activeFilter);
          });
        chatModel._ocrmListenersBound = true;
      }
    }
  }

  // ================================================================
  // SECTION 7E: ROW BUILDER (Kraya ki() equivalent)
  // ================================================================

  /**
   * Get the correct row height based on WhatsApp variant.
   * Kraya equivalent: ri() (main-bundle.min.js line 4260)
   *
   * WhatsApp Business uses 76px rows; standard WA uses 72px.
   *
   * @returns {number} Row height in pixels
   */
  function getRowHeight() {
    return isBusinessApp ? 76 : 72;
  }

  /**
   * Detect if WhatsApp Business is running and set isBusinessApp.
   * Call during init after WA DOM is loaded.
   */
  function detectBusinessApp() {
    try {
      if (
        document.querySelector('[data-icon="business-filled"]') ||
        document.querySelector("._asiw") ||
        document.querySelector('[data-app-version*="business"]')
      ) {
        isBusinessApp = true;
      }
      if (window.WPP && window.WPP.conn && window.WPP.conn.isSMB) {
        isBusinessApp = window.WPP.conn.isSMB();
      }
    } catch (e) {
      // Default: not business
    }
    console.log("[OceanCRM:MAIN] Business app detected: " + isBusinessApp);
  }

  /**
   * Escape HTML special characters to prevent XSS in rendered row HTML.
   *
   * @param {string} str
   * @returns {string}
   */
  function sanitizeHTML(str) {
    if (!str) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Format a Unix timestamp into a human-readable string.
   * - Today: "HH:MM" (24h or 12h matching WA's locale)
   * - Yesterday: "Yesterday"
   * - Within 7 days: weekday name (e.g. "Mon")
   * - Older: "DD/MM/YYYY"
   *
   * @param {number} unixTs - Unix timestamp in seconds
   * @returns {string}
   */
  function formatMessageTime(unixTs) {
    if (!unixTs) return "";
    try {
      var now = new Date();
      var d = new Date(unixTs * 1000);
      var nowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      var diffDays = Math.round((nowStart - dStart) / (1000 * 60 * 60 * 24));

      if (diffDays === 0) {
        // Today — show HH:MM
        var h = d.getHours();
        var m = d.getMinutes();
        return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
      } else if (diffDays === 1) {
        return "Yesterday";
      } else if (diffDays < 7) {
        var days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        return days[d.getDay()];
      } else {
        return (
          String(d.getDate()).padStart(2, "0") +
          "/" +
          String(d.getMonth() + 1).padStart(2, "0") +
          "/" +
          d.getFullYear()
        );
      }
    } catch (e) {
      return "";
    }
  }

  /**
   * Generate avatar HTML for a chat.
   * Uses the chat's profilePicThumbObj URL if available; falls back to a
   * coloured initials placeholder matching WA's visual style.
   *
   * @param {Object} chat - Live WPP Backbone chat model
   * @returns {string} HTML string
   */
  function getProfileImageHTML(chat) {
    var imgUrl = null;
    try {
      if (chat.profilePicThumbObj && chat.profilePicThumbObj.eurl) {
        imgUrl = chat.profilePicThumbObj.eurl;
      } else if (chat.profilePicThumbObj && chat.profilePicThumbObj.imgFull) {
        imgUrl = chat.profilePicThumbObj.imgFull;
      }
    } catch (e) {
      // ignore
    }

    var name = chat.formattedTitle || chat.name || chat.id.user || "?";
    var initials = name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map(function (w) {
        return w[0] ? w[0].toUpperCase() : "";
      })
      .join("");

    // Deterministic background colour from chat ID
    var colors = [
      "#d32f2f",
      "#c62828",
      "#ad1457",
      "#6a1b9a",
      "#4527a0",
      "#283593",
      "#1565c0",
      "#0277bd",
      "#00838f",
      "#2e7d32",
      "#558b2f",
      "#f57f17",
      "#e65100",
      "#4e342e",
      "#546e7a",
    ];
    var idStr = chat.id._serialized || "";
    var colorIdx = 0;
    for (var ci = 0; ci < idStr.length; ci++) {
      colorIdx = (colorIdx + idStr.charCodeAt(ci)) % colors.length;
    }
    var bgColor = colors[colorIdx];

    if (imgUrl) {
      return (
        '<span data-testid="default-user" data-icon="default-user">' +
        '<img src="' +
        sanitizeHTML(imgUrl) +
        '" class="x1rg5ohu xuxw1ft _ao3e"' +
        ' style="width:49px;height:49px;border-radius:50%;object-fit:cover;"' +
        " onerror=\"this.style.display='none';this.nextSibling.style.display='flex';\"" +
        "/>" +
        '<div style="display:none;width:49px;height:49px;border-radius:50%;' +
        "background:" +
        bgColor +
        ";color:#fff;font-size:20px;font-weight:bold;" +
        'align-items:center;justify-content:center;">' +
        sanitizeHTML(initials) +
        "</div>" +
        "</span>"
      );
    } else {
      return (
        '<span data-testid="default-user" data-icon="default-user">' +
        '<div style="width:49px;height:49px;border-radius:50%;' +
        "background:" +
        bgColor +
        ";color:#fff;font-size:20px;font-weight:bold;" +
        'display:flex;align-items:center;justify-content:center;">' +
        sanitizeHTML(initials) +
        "</div>" +
        "</span>"
      );
    }
  }

  /**
   * Return an SVG/span icon for a given WA message type.
   * Mirrors WA's media-type icons shown in the chat list preview.
   *
   * @param {string} type - WPP message type (e.g. "image", "video", "ptt")
   * @returns {string} HTML string (empty string for plain text)
   */
  function getMessageTypeIcon(type) {
    var iconStyle =
      'style="display:inline-block;vertical-align:middle;margin-right:3px;' +
      'opacity:0.7;font-size:13px;"';
    switch (type) {
      case "image":
        return "<span " + iconStyle + ">📷</span>";
      case "video":
        return "<span " + iconStyle + ">🎥</span>";
      case "ptt":
      case "audio":
        return "<span " + iconStyle + ">🎤</span>";
      case "document":
        return "<span " + iconStyle + ">📄</span>";
      case "sticker":
        return "<span " + iconStyle + ">🎭</span>";
      case "vcard":
      case "multi_vcard":
        return "<span " + iconStyle + ">👤</span>";
      case "location":
        return "<span " + iconStyle + ">📍</span>";
      case "gif":
        return "<span " + iconStyle + ">GIF</span>";
      default:
        return "";
    }
  }

  /**
   * Return SVG tick mark HTML for a message's ack (acknowledgement) state.
   * Only shown on outgoing (fromMe) messages.
   *
   * WA ack values:
   *   -1 = error, 0 = pending clock, 1 = sent (single tick),
   *   2 = delivered (double tick), 3 = read (blue ticks), 4 = played
   *
   * Kraya uses SVG paths from WhatsApp's own icon set; we use Unicode
   * approximations styled to match.
   *
   * @param {number} ack - WPP message ack value
   * @returns {string} HTML string
   */
  function getReadReceiptIcon(ack) {
    var baseStyle =
      'style="display:inline-block;vertical-align:middle;margin-right:2px;font-size:12px;"';
    switch (ack) {
      case -1:
        return "<span " + baseStyle + ' style="color:#f44336;">⚠</span>';
      case 0:
        return (
          "<span " +
          baseStyle +
          ' style="color:var(--ocrm-time-color,#aaa);">🕐</span>'
        );
      case 1:
        // Sent — single grey tick
        return (
          "<span " +
          baseStyle +
          ' style="color:var(--ocrm-time-color,#aaa);">✓</span>'
        );
      case 2:
        // Delivered — double grey tick
        return (
          "<span " +
          baseStyle +
          ' style="color:var(--ocrm-time-color,#aaa);">✓✓</span>'
        );
      case 3:
      case 4:
        // Read / Played — blue ticks
        return "<span " + baseStyle + ' style="color:#53bdeb;">✓✓</span>';
      default:
        return "";
    }
  }

  /**
   * Build the badge HTML for a chat row (right-side badges column).
   *
   * Includes (in order, matching WA's layout):
   *   1. CRM stage badge (if chat has a stage)
   *   2. Unread count badge (if unread)
   *   3. Pin indicator (if pinned)
   *   4. Mute indicator (if muted)
   *
   * Kraya equivalent: the badges section inside ki()
   *
   * @param {Object} chat   - Live WPP Backbone chat model
   * @param {string} chatId - chat.id._serialized
   * @returns {string} HTML string
   */
  function getBadgesHTML(chat, chatId) {
    var html = "";

    // CRM stage badge
    var lead = leads[chatId];
    if (lead && lead.stage_slug) {
      // Find matching stage for colour
      var stageColor = "#888";
      var stageName = lead.stage_slug;
      for (var s = 0; s < stages.length; s++) {
        if (stages[s].slug === lead.stage_slug) {
          stageColor = stages[s].color || "#888";
          stageName = stages[s].name || lead.stage_slug;
          break;
        }
      }
      html += TEMPLATES[uiVersion]["stage-highlight"](stageName, stageColor);
    }

    // Unread count badge
    if (chat.unreadCount > 0) {
      html += TEMPLATES[uiVersion]["chat-unread-badge"](chat.unreadCount);
    } else if (chat.hasUnread) {
      // hasUnread without count — show a dot badge
      html += TEMPLATES[uiVersion]["chat-unread-badge"]("");
    }

    // Pin indicator
    if (chat.pin && chat.pin > 0) {
      html +=
        '<span style="display:inline-block;font-size:12px;' +
        'color:var(--ocrm-time-color,#aaa);margin-left:2px;" title="Pinned">📌</span>';
    }

    // Mute indicator
    if (chat.muteExpiration && chat.muteExpiration !== 0) {
      html +=
        '<span style="display:inline-block;font-size:12px;' +
        'color:var(--ocrm-time-color,#aaa);margin-left:2px;" title="Muted">🔇</span>';
    }

    return html;
  }

  /**
   * Build a single chat row DOM element from a live WPP chat model.
   *
   * Kraya equivalent: ki() (main-bundle.min.js line 4491)
   *
   * Key difference from the old getOrBuildRow():
   *   - Old: cloned a native WA DOM element from nativeRowCache
   *   - New: builds custom HTML from live model data (always current, always available)
   *
   * The row HTML uses WA's own CSS class names (via TEMPLATES) so it looks
   * visually identical to native WA rows.
   *
   * @param {Object} chat   - Live WPP Backbone chat model
   * @param {number} offset - Pixel offset for translateY() positioning
   * @returns {jQuery} jQuery-wrapped DOM element
   */
  function buildChatRowHTML(chat, offset) {
    var chatId = chat.id._serialized;
    var displayName =
      chat.formattedTitle || chat.name || chat.id.user || "Unknown";
    var hasUnreadFlag = isUnread(chat);

    // ── Avatar HTML ──
    var avatarHtml = getProfileImageHTML(chat);

    // ── Last message data ──
    var lastMsgText = "";
    var lastMsgTime = "";
    var readReceiptHtml = "";
    var mediaIconHtml = "";
    var authorName = "";

    try {
      var msgs =
        chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
      if (msgs.length > 0) {
        var lastMsg = msgs[msgs.length - 1];

        // ── Message preview text ──
        lastMsgText = lastMsg.body || lastMsg.caption || "";
        if (lastMsg.type === "image") lastMsgText = lastMsgText || "Photo";
        else if (lastMsg.type === "video") lastMsgText = lastMsgText || "Video";
        else if (lastMsg.type === "ptt" || lastMsg.type === "audio")
          lastMsgText = lastMsgText || "Audio";
        else if (lastMsg.type === "document")
          lastMsgText = lastMsg.filename || "Document";
        else if (lastMsg.type === "sticker") lastMsgText = "Sticker";
        else if (lastMsg.type === "vcard" || lastMsg.type === "multi_vcard")
          lastMsgText = "Contact";
        else if (lastMsg.type === "location") lastMsgText = "Location";
        else if (lastMsg.type === "gif") lastMsgText = lastMsgText || "GIF";

        if (lastMsgText.length > 80) {
          lastMsgText = lastMsgText.substring(0, 80) + "...";
        }

        // ── Time ──
        lastMsgTime = formatMessageTime(lastMsg.t || chat.t);

        // ── Media icon ──
        mediaIconHtml = getMessageTypeIcon(lastMsg.type);

        // ── Read receipt / author ──
        if (lastMsg.id && lastMsg.id.fromMe) {
          authorName = "You";
          readReceiptHtml = getReadReceiptIcon(lastMsg.ack);
        } else if (chat.isGroup && lastMsg.author) {
          // Group chat — show sender's name
          try {
            var senderContact = lastMsg.senderObj || lastMsg.sender;
            if (senderContact) {
              authorName =
                senderContact.pushname ||
                senderContact.name ||
                senderContact.formattedName ||
                (lastMsg.author && lastMsg.author.user) ||
                "";
            }
          } catch (e) {
            // ignore
          }
        }
      } else {
        lastMsgTime = formatMessageTime(chat.t);
      }
    } catch (e) {
      lastMsgTime = formatMessageTime(chat.t);
    }

    // ── Badges HTML (stage + unread count + pin + mute) ──
    var badgesHtml = getBadgesHTML(chat, chatId);

    // ── CRM name override: prefer lead business name for unknown contacts ──
    var lead = leads[chatId];
    if (lead && lead.business && lead.business.name) {
      var lowerName = displayName.toLowerCase();
      if (
        lowerName === "unknown user" ||
        lowerName === "unknown number" ||
        lowerName === chat.id.user
      ) {
        displayName = lead.business.name;
      }
    }

    // ── Build HTML via version-specific template ──
    var html = TEMPLATES[uiVersion]["chat-node-html"](
      offset,
      chatId,
      hasUnreadFlag,
      avatarHtml,
      displayName,
      lastMsgTime,
      lastMsgText,
      readReceiptHtml,
      mediaIconHtml,
      authorName,
      badgesHtml,
    );

    return $(html);
  }

  /**
   * Create a chat row, cache it, attach DOM event handlers and Backbone listeners.
   *
   * Kraya equivalent: ms() (main-bundle.min.js line 5464)
   *
   * This is the canonical function for creating rows for the chat list.
   * It attaches:
   *   1. Click handler → onChatRowClick() (open chat in WA)
   *   2. Backbone change:msgs listener (re-render row on new messages)
   *   3. Backbone change:unreadCount listener (re-render row + re-sort bucket)
   *
   * NOTE: renderVisibleRows() also creates rows directly for virtual scroll
   * performance. createRow() is used when we need guaranteed Backbone binding
   * at creation time (e.g. initial full render via rebuildChatList).
   *
   * @param {Object} chat   - Live WPP Backbone chat model
   * @param {number} offset - Pixel offset for translateY() positioning
   * @returns {jQuery} The created and cached row element
   */
  function createRow(chat, offset) {
    var $row = buildChatRowHTML(chat, offset);
    var chatId = chat.id._serialized;

    // Cache the built row
    rowCache[chatId] = $row;

    // ── DOM event handlers ──
    $row.off("click.ocrm").on("click.ocrm", onChatRowClick);
    // Future: $row.off("contextmenu.ocrm").on("contextmenu.ocrm", onChatRowContextMenu);

    // ── Backbone listeners (real-time reactivity) ──
    // Guard against double-binding — only attach once per model
    if (!chat._ocrmListenersBound) {
      chat
        .off("change:msgs.ocrm")
        .on("change:msgs.ocrm", function (changedChat) {
          onChatChanged(changedChat);
        });

      chat
        .off("change:unreadCount.ocrm")
        .on("change:unreadCount.ocrm", async function (changedChat) {
          onChatChanged(changedChat);
          // Re-render the whole list — chat may move in/out of the unread bucket
          await rebuildChatList(activeFilter);
        });

      chat._ocrmListenersBound = true;
    }

    return $row;
  }

  // ================================================================
  // SECTION 7G: REACTIVITY — onChatChanged / bucket helpers
  // ================================================================

  /**
   * Handle a Backbone model change event on a chat.
   *
   * Kraya equivalent: ya() (main-bundle.min.js line 3656)
   *
   * When a chat's messages or unread count changes:
   *   1. Update the chat in liveChatModels / liveChatMap (already live — just re-sort)
   *   2. Update bucket membership (add to unread if newly unread, etc.)
   *   3. Re-render the row in the DOM if it's currently visible
   *   4. Update tab counts
   *
   * @param {Object} chat - The live WPP Backbone chat model that changed
   */
  function onChatChanged(chat) {
    if (!chat || !chat.id) return;
    var chatId = chat.id._serialized;

    // ── 1. Ensure model is in our maps (it should be already) ──
    liveChatMap[chatId] = chat;

    // ── 2. Update bucket membership ──
    // Unread bucket
    if (isUnread(chat)) {
      addToBucket(chatId, "unread-chats");
    } else {
      removeFromBucket(chat, "unread-chats");
    }

    // Groups bucket
    if (chat.isGroup) {
      addToBucket(chatId, "groups");
    }

    // Needs Reply bucket
    var needsReply = false;
    if (!chat.isGroup && isUnread(chat)) {
      try {
        var msgs =
          chat.msgs && chat.msgs.getModelsArray
            ? chat.msgs.getModelsArray()
            : [];
        if (msgs.length > 0) {
          var lastMsg = msgs[msgs.length - 1];
          if (lastMsg && !lastMsg.id.fromMe) {
            needsReply = true;
          }
        }
      } catch (e) {
        /* ignore */
      }
    }
    if (needsReply) {
      addToBucket(chatId, "needs-reply");
    } else {
      removeFromBucket(chat, "needs-reply");
    }

    // Stage bucket (unchanged — CRM lead data doesn't change on WA events)

    // ── 3. Re-render the row if currently visible ──
    if (renderedRows[chatId]) {
      var oldRow = renderedRows[chatId];
      var idx = parseInt(oldRow.getAttribute("data-ocrm-idx") || "0", 10);
      var offset = idx * getRowHeight();
      var $newRow = buildChatRowHTML(chat, offset);

      // Position
      $newRow[0].style.position = "absolute";
      $newRow[0].style.top = "0";
      $newRow[0].style.left = "0";
      $newRow[0].style.right = "0";
      $newRow[0].style.zIndex = "7";
      $newRow[0].style.transition = "none";
      $newRow[0].setAttribute("data-ocrm-idx", idx);

      // Bind click
      $newRow.off("click.ocrm").on("click.ocrm", onChatRowClick);

      // Replace in DOM
      if (oldRow.parentNode) {
        oldRow.parentNode.replaceChild($newRow[0], oldRow);
      }
      renderedRows[chatId] = $newRow[0];
      rowCache[chatId] = $newRow;
    }

    // ── 4. Update tab counts ──
    updateTabCounts();
  }

  /**
   * Add a chat to a specific bucket (if not already present).
   * Kraya equivalent: et() (main-bundle.min.js line 666)
   *
   * @param {string} chatId - Chat's _serialized ID
   * @param {string} bucketSlug - Bucket name (e.g., "unread-chats")
   */
  function addToBucket(chatId, bucketSlug) {
    if (!buckets[bucketSlug]) return;

    var chat = liveChatMap[chatId];
    if (!chat || chat.archive) return;

    // Check if already in bucket
    var alreadyIn = false;
    for (var i = 0; i < buckets[bucketSlug].length; i++) {
      if (buckets[bucketSlug][i].id._serialized === chatId) {
        alreadyIn = true;
        break;
      }
    }
    if (!alreadyIn) {
      buckets[bucketSlug].unshift(chat); // Add at front (newest)
    }
  }

  /**
   * Remove a chat from one or all buckets.
   * Kraya equivalent: Xe() (main-bundle.min.js line 655)
   *
   * @param {Object} chat - Live WPP Backbone chat model
   * @param {string|null} bucketSlug - Specific bucket, or null for ALL buckets
   */
  function removeFromBucket(chat, bucketSlug) {
    var chatId = chat.id._serialized;

    if (bucketSlug) {
      // Remove from specific bucket
      if (buckets[bucketSlug]) {
        buckets[bucketSlug] = buckets[bucketSlug].filter(function (c) {
          return c.id._serialized !== chatId;
        });
      }
    } else {
      // Remove from ALL buckets
      for (var key in buckets) {
        buckets[key] = buckets[key].filter(function (c) {
          return c.id._serialized !== chatId;
        });
      }
    }
  }

  // ================================================================
  // SECTION 7H: INTERACTION — onChatRowClick / onChatOpened
  // ================================================================

  /**
   * Handle click on a custom-rendered chat row.
   *
   * Kraya equivalent: Ls() (main-bundle.min.js line 5639)
   *
   * Flow:
   *   1. Extract chat ID from data-chat-id attribute
   *   2. Open the chat in WhatsApp via WPP API
   *   3. Call onChatOpened() to clear unread state
   *   4. Highlight the selected row
   *
   * @param {Event} event - jQuery click event
   */
  async function onChatRowClick(event) {
    var $row = $(event.currentTarget).closest("[data-chat-id]");
    var chatId = $row.attr("data-chat-id");
    if (!chatId) return;

    var chat = liveChatMap[chatId];
    if (!chat) return;

    // Don't re-open the same chat
    if (selectedChat && selectedChat.id._serialized === chatId) {
      highlightSelectedChat();
      return;
    }

    // Open the chat in WhatsApp
    try {
      if (WPP.chat.openChatFromUnread) {
        await WPP.chat.openChatFromUnread(chatId);
      } else if (WPP.chat.openChatBottom) {
        await WPP.chat.openChatBottom(chatId);
      } else if (WPP.chat.openChatAt) {
        await WPP.chat.openChatAt(chatId);
      }
    } catch (e) {
      console.warn("[OceanCRM:MAIN] Error opening chat:", e.message);
      // Fallback: URL hash navigation
      var phone = chatId.split("@")[0];
      window.location.hash = "#/chat/" + phone;
    }

    // Update selected state
    onChatOpened(chat);
  }

  /**
   * Handle a chat being opened/selected.
   *
   * Kraya equivalent: ws() (main-bundle.min.js line 5531)
   *
   * Flow:
   *   1. Set selectedChat to the opened chat
   *   2. Remove visual unread indicators from the row
   *   3. If chat was unread: reset unreadCount, update model, remove from unread bucket
   *   4. If currently viewing unread filter: re-render (chat should disappear)
   *   5. Update tab counts
   *   6. Highlight the selected row
   *
   * @param {Object} chat - Live WPP Backbone chat model
   */
  function onChatOpened(chat) {
    if (!chat) return;
    var chatId = chat.id._serialized;

    // Set as selected
    selectedChat = chat;

    // If chat was unread, clear the unread state
    if (isUnread(chat)) {
      // Reset unread count on the model
      // (WPP/WA will also do this internally when chat opens,
      //  but we do it proactively for immediate UI update)
      chat.unreadCount = 0;

      // Update the model via onChatChanged
      onChatChanged(chat);

      // Remove from unread bucket
      removeFromBucket(chat, "unread-chats");

      // Also check needs-reply
      removeFromBucket(chat, "needs-reply");
    }

    // If on unread tab, re-render (chat should disappear from list)
    if (activeFilter === "unread-chats" || activeFilter === "needs-reply") {
      rebuildChatList(activeFilter);
    }

    // Update counts
    updateTabCounts();

    // Highlight selected row
    highlightSelectedChat();
  }

  /**
   * Visually highlight the currently selected chat row.
   * Removes highlight from all rows, adds it to the selected one.
   */
  function highlightSelectedChat() {
    if (!selectedChat) return;
    var chatId = selectedChat.id._serialized;

    // Remove selection from all rows
    $("[data-chat-id]")
      .find("." + SELECTORS[uiVersion]["chat-node"].split(".").pop())
      .removeClass("_ak7p"); // selection class

    // Add selection to current
    var $selectedRow = $('[data-chat-id="' + chatId + '"]');
    if ($selectedRow.length) {
      $selectedRow
        .find("." + SELECTORS[uiVersion]["chat-node"].split(".").pop())
        .addClass("_ak7p");
    }
  }

  // ================================================================
  // SECTION 7I: NATIVE FILTER REMOVAL — removeNativeFilters()
  // ================================================================

  /**
   * Remove WhatsApp's native filter buttons (All, Unread, Favourites, Groups).
   *
   * Kraya equivalent: fi() (main-bundle.min.js line 4328)
   *
   * These buttons conflict with OceanCRM's own filter tabs.
   * Without removing them, users see TWO "Unread" filters — confusing.
   *
   * WA elements removed:
   *   - [aria-label="Unread chats filter"] — the native Unread button
   *   - [aria-label="chat-list-filters"] — the entire filter bar (All/Unread/Fav/Groups)
   *
   * Called once during initialization after WA DOM is ready.
   */
  function removeNativeFilters() {
    try {
      // Remove the entire filter bar container
      var filterBar = document.querySelector(
        '[aria-label="chat-list-filters"]',
      );
      if (filterBar) {
        filterBar.style.display = "none";
        console.log("[OceanCRM:MAIN] Hidden WA native chat filter bar");
      }

      // Also hide individual filter buttons as fallback
      var unreadFilter = document.querySelector(
        '[aria-label="Unread chats filter"]',
      );
      if (unreadFilter) {
        unreadFilter.style.display = "none";
      }

      // WA v2.3 also has a filter menu button
      var filterMenu = document.querySelector('[title="Chat filters menu"]');
      if (filterMenu) {
        filterMenu.style.display = "none";
      }
    } catch (e) {
      console.warn("[OceanCRM:MAIN] Error removing native filters:", e);
    }
  }

  // ================================================================
  // SECTION 7J: REACTIVE BUCKET REFRESH — refreshBuckets()
  // ================================================================

  /**
   * Re-categorize all live chat models into buckets.
   *
   * Kraya equivalent: Tt() (main-bundle.min.js line 1828)
   * Kraya runs this every 5 seconds via setInterval.
   *
   * Unlike buildBuckets() which fetches data from WPP, this works
   * purely on the already-loaded liveChatModels array (fast, synchronous).
   *
   * Flow:
   *   1. Re-filter existing liveChatModels into buckets
   *   2. Update tab counts
   *   3. If active filter's data changed, re-render
   */
  function refreshBuckets() {
    if (!liveChatModels || liveChatModels.length === 0) return;

    var oldCounts = {};
    for (var key in buckets) {
      oldCounts[key] = buckets[key].length;
    }

    // Re-sort by timestamp (live models have updated .t values)
    liveChatModels.sort(function (a, b) {
      return (b.t || 0) - (a.t || 0);
    });

    // ── Re-categorize ──
    buckets["all-chats"] = [];
    buckets["unread-chats"] = [];
    buckets["needs-reply"] = [];
    buckets["groups"] = [];
    // pending-reminders stays empty (excluded from scope)

    // Re-init stage buckets
    for (var s = 0; s < stages.length; s++) {
      if (!stages[s].is_default) {
        buckets[stages[s].slug] = [];
      }
    }

    for (var i = 0; i < liveChatModels.length; i++) {
      var chat = liveChatModels[i];
      var chatId = chat.id._serialized;
      if (chat.archive) continue;

      buckets["all-chats"].push(chat);

      if (isUnread(chat)) {
        buckets["unread-chats"].push(chat);
      }

      if (chat.isGroup) {
        buckets["groups"].push(chat);
      }

      if (!chat.isGroup && isUnread(chat)) {
        var msgs =
          chat.msgs && chat.msgs.getModelsArray
            ? chat.msgs.getModelsArray()
            : [];
        if (msgs.length > 0) {
          var lastMsg = msgs[msgs.length - 1];
          if (lastMsg && !lastMsg.id.fromMe) {
            buckets["needs-reply"].push(chat);
          }
        }
      }

      var lead = leads[chatId];
      if (lead && lead.stage_slug) {
        if (buckets[lead.stage_slug] === undefined) {
          buckets[lead.stage_slug] = [];
        }
        buckets[lead.stage_slug].push(chat);
      }
    }

    // ── Update counts ──
    updateTabCounts();

    // ── Re-render if active filter count changed ──
    if (activeFilter !== "all-chats") {
      var newCount = (buckets[activeFilter] || []).length;
      var oldCount = oldCounts[activeFilter] || 0;
      if (newCount !== oldCount) {
        rebuildChatList(activeFilter);
      }
    }
  }

  // ================================================================
  // SECTION 7F: CHAT LIST RESTORE
  // ================================================================

  /**
   * Restore WA's native chat list control.
   * Removes our cloned #pane-side and unhides WA's hidden original.
   * Called when switching back to "all-chats".
   */
  function restoreNativeChatList() {
    // Unbind our scroll handler from scroll container and pane
    if (scrollContainerEl) {
      $(scrollContainerEl).off("scroll.ocrm");
      // Restore natural overflow so WA's own scrolling works again
      scrollContainerEl.style.overflowY = "";
      scrollContainerEl.style.overflowX = "";
      scrollContainerEl = null;
    }
    if (paneSideEl) {
      $(paneSideEl).off("scroll.ocrm");
    }

    // Remove our cloned #pane-side from the DOM
    var ourPaneSide = document.getElementById("pane-side");
    if (
      ourPaneSide &&
      waOriginalPaneSide &&
      ourPaneSide !== waOriginalPaneSide
    ) {
      ourPaneSide.parentNode.removeChild(ourPaneSide);
    }

    // Restore WA's hidden original
    if (waOriginalPaneSide) {
      waOriginalPaneSide.id = "pane-side";
      waOriginalPaneSide.style.display = "";
      paneSideEl = waOriginalPaneSide;
      waOriginalPaneSide = null;
    } else {
      paneSideEl = document.getElementById("pane-side");
    }

    renderedRows = {};
    rowCache = {}; // Clear our built-row cache
    isOcrmControllingChatList = false;
    currentFilteredIds = [];

    // Re-attach Observer 1 on the restored WA element
    watchChatListForFilterPersistence();

    // Re-hide native filters (WA may have re-created them)
    removeNativeFilters();

    console.log("[OceanCRM:MAIN] Native WA chat list restored");
  }

  // ================================================================
  // SECTION 7D: OBSERVERS (filter persistence)
  // ================================================================

  /**
   * Watch WhatsApp's chat list for DOM changes.
   *
   * With the live-model approach, WA's React manages the hidden original
   * #pane-side. Our clone is fully under our control.
   *
   * Observer 1 — watches #pane-side for DOM mutations
   *   → No longer caches native rows (live models replace nativeRowCache)
   *   → Kept as a lightweight presence detector
   *   → Disconnected when we take over (in rebuildChatList)
   *
   * Observer 2 — watches #side for pane-side removal (SPA navigation)
   *   → Handles removal of our clone OR WA's hidden original
   *   → Created once (guarded by paneSideRecoveryObserver)
   *
   * Kraya equivalent: Qe() (main-bundle.min.js line 595)
   */
  function watchChatListForFilterPersistence() {
    // ── Observer 1: Cache new WA rows (all-chats mode only) ──
    var paneSide = document.getElementById("pane-side");
    if (paneSide) {
      if (chatListObserver) {
        chatListObserver.disconnect();
      }

      chatListObserver = new MutationObserver(function (mutations) {
        // Only cache rows when WA is in control (all-chats, not filtering)
        if (activeFilter !== "all-chats" || isOcrmControllingChatList) return;

        var hasNewRows = false;
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
            hasNewRows = true;
            break;
          }
        }
        if (!hasNewRows) return;
        // Observer 1 no longer caches native rows — live models are used instead.
        // Only the pane-side removal (Observer 2) needs action.
      });

      chatListObserver.observe(paneSide, {
        childList: true,
        subtree: true,
      });

      console.log("[OceanCRM:MAIN] Chat list MutationObserver started");
    } else {
      console.warn("[OceanCRM:MAIN] #pane-side not found — retrying in 2s");
      setTimeout(watchChatListForFilterPersistence, 2000);
    }

    // ── Observer 2: Pane-side removal (created once) ──
    if (!paneSideRecoveryObserver) {
      var sideEl = document.getElementById("side");
      if (sideEl) {
        paneSideRecoveryObserver = new MutationObserver(function (mutations) {
          for (var i = 0; i < mutations.length; i++) {
            var removed = mutations[i].removedNodes;
            if (!removed) continue;

            for (var j = 0; j < removed.length; j++) {
              var removedId = removed[j].id;

              // WA removed its hidden original — just clean up reference
              if (removedId === "pane-side-wa-backup") {
                console.log(
                  "[OceanCRM:MAIN] WA removed hidden original pane-side (cleanup)",
                );
                waOriginalPaneSide = null;
                continue;
              }

              // Our clone (or WA's active pane-side) was removed
              if (removedId === "pane-side") {
                console.log("[OceanCRM:MAIN] #pane-side removed — recovering");

                paneSideEl = null;
                renderedRows = {};
                currentFilteredIds = [];

                // If we have the hidden WA original, restore it
                if (waOriginalPaneSide && waOriginalPaneSide.parentNode) {
                  waOriginalPaneSide.id = "pane-side";
                  waOriginalPaneSide.style.display = "";
                  paneSideEl = waOriginalPaneSide;
                  waOriginalPaneSide = null;
                  isOcrmControllingChatList = false;
                  watchChatListForFilterPersistence();
                  console.log(
                    "[OceanCRM:MAIN] Restored WA original from backup",
                  );
                  return;
                }

                // No backup — poll for WA to recreate #pane-side
                isOcrmControllingChatList = false;
                var recoveryTimer = setInterval(function () {
                  var newPaneSide = document.getElementById("pane-side");
                  if (newPaneSide) {
                    clearInterval(recoveryTimer);
                    paneSideEl = newPaneSide;
                    console.log(
                      "[OceanCRM:MAIN] #pane-side recovered — re-attaching observer",
                    );
                    watchChatListForFilterPersistence();
                    if (activeFilter !== "all-chats") {
                      rebuildChatList(activeFilter);
                    }
                  }
                }, 500);

                setTimeout(function () {
                  clearInterval(recoveryTimer);
                }, 30000);

                return;
              }
            }
          }
        });

        paneSideRecoveryObserver.observe(sideEl, { childList: true });
        console.log("[OceanCRM:MAIN] Pane-side recovery observer started");
      }
    }
  }

  // ================================================================
  // SECTION 8: INITIALIZATION
  // ================================================================

  /**
   * Wait for jQuery to be available.
   * content.js injects jQuery before this script runs,
   * but there may be a brief delay.
   */
  function waitForJQuery(callback) {
    if (typeof window.jQuery !== "undefined") {
      callback();
      return;
    }

    var attempts = 0;
    var maxAttempts = 100; // 50 seconds max
    var timer = setInterval(function () {
      attempts++;
      if (typeof window.jQuery !== "undefined") {
        clearInterval(timer);
        console.log(
          "[OceanCRM:MAIN] jQuery ready after " + attempts * 500 + "ms",
        );
        callback();
        return;
      }
      if (attempts >= maxAttempts) {
        clearInterval(timer);
        console.error(
          "[OceanCRM:MAIN] jQuery not found after 50s — navbar disabled",
        );
      }
    }, 500);
  }

  /**
   * Initialize the full UI + data loading pipeline.
   *
   * Phase 2: Renders empty navbar shell
   * Phase 3: Loads CRM data → populates navbar → activates filtering
   *
   * Called after both jQuery and WPP are ready.
   */
  function initUI() {
    console.log("[OceanCRM:MAIN] Initializing UI...");

    // Phase 2: Detect WA version + render navbar shell
    detectWAVersion();
    detectBusinessApp(); // Detect WA Business (76px rows vs 72px)
    renderNavbar({
      stages: stages,
      buckets: buckets,
      version: "1.2.0",
    });
    removeNativeFilters(); // Hide WA's native All/Unread/Fav/Groups filter bar

    // Resize handler (debounced)
    var resizeTimer = null;
    $(window).on("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        adjustLayout();
        updateScrollButtonVisibility();
      }, 150);
    });

    // Phase 3: Load CRM data
    loadCRMData();
  }

  /**
   * Load all CRM data: auth → org → stages → leads → buckets → filter.
   *
   * This is the main Phase 3 orchestrator. It runs sequentially because
   * each step depends on the previous one:
   *   1. Auth check → needed to know if we can load data
   *   2. Fetch orgs → needed for org ID
   *   3. Fetch stages → needed for bucket initialization
   *   4. Load leads → needed for bucket population
   *   5. Build buckets → needed for filtering
   *   6. Re-render navbar with real data
   *   7. Start filter persistence observer
   *   8. Start auto-refresh timer
   *
   * On failure at any step, the navbar remains rendered with zeros.
   * The user can still see WA's native chat list.
   */
  async function loadCRMData() {
    console.log("[OceanCRM:MAIN] Starting CRM data load...");

    try {
      // ── Step 1: Auth check ──
      var authResult = await pingAuth();
      if (authResult && authResult.ok !== false && authResult.data) {
        isLoggedIn = true;
        userData = authResult.data;
        console.log(
          "[OceanCRM:MAIN] Authenticated as: " +
            (userData.name || userData.email),
        );

        // Update login button
        $("#ocrm-login-btn").find(".ocrm-btn-label").text("Logout");
        $("#ocrm-login-btn").attr(
          "title",
          "Logged in as " + (userData.name || ""),
        );
      } else {
        console.log(
          "[OceanCRM:MAIN] Not authenticated — navbar shown with empty data",
        );
        isLoggedIn = false;
        return; // Stop here — can't load data without auth
      }

      // ── Step 2: Fetch organizations ──
      var orgs = await fetchOrgs();
      if (!orgs || orgs.length === 0) {
        console.warn("[OceanCRM:MAIN] No organizations found");
        return;
      }
      orgId = orgs[0].id;
      console.log(
        "[OceanCRM:MAIN] Organization: " + orgs[0].name + " (" + orgId + ")",
      );

      // ── Step 3: Fetch stages ──
      var rawStages = await fetchStages(orgId);
      stages = enrichStages(rawStages);
      console.log("[OceanCRM:MAIN] Stages loaded: " + stages.length);

      // ── Step 4: Load all leads (paginated) ──
      var loadResult = await loadAllLeads(orgId);
      console.log(
        "[OceanCRM:MAIN] Leads: " +
          loadResult.loaded +
          " mapped, " +
          loadResult.orphaned +
          " orphaned",
      );

      // ── Step 5: Build buckets ──
      await buildBuckets();
      // Phase 4: injectChatBadges() will be called here after badge implementation

      // ── Step 5b: Start 5-second bucket refresh (Kraya's Tt() interval) ──
      if (bucketRefreshTimer) clearInterval(bucketRefreshTimer);
      bucketRefreshTimer = setInterval(refreshBuckets, BUCKET_REFRESH_MS);
      console.log("[OceanCRM:MAIN] Bucket refresh started (every 5s)");

      // ── Step 6: Re-render navbar with real data ──
      renderNavbar({
        stages: stages,
        buckets: buckets,
        version: "1.2.0",
      });

      // Update login button after re-render (renderNavbar resets it to "Login")
      if (isLoggedIn) {
        $("#ocrm-login-btn").find(".ocrm-btn-label").text("Logout");
        $("#ocrm-login-btn").attr(
          "title",
          "Logged in as " + (userData && userData.name ? userData.name : ""),
        );
      }

      // ── Step 7: Start filter persistence observer ──
      watchChatListForFilterPersistence();

      // ── Step 8: Start auto-refresh ──
      startAutoRefresh();

      dataLoaded = true;
      console.log("[OceanCRM:MAIN] CRM data load complete ✓");
    } catch (err) {
      console.error("[OceanCRM:MAIN] CRM data load failed:", err);
      // Navbar is already rendered with zeros — user can still use WA
    }
  }

  /**
   * Start the auto-refresh timer that reloads leads and refreshes buckets
   * every 5 minutes.
   *
   * This ensures:
   *   - New leads created via the web app are reflected in the extension
   *   - Stage changes made on other devices are synced
   *   - Unread/needs-reply counts are updated
   *
   * Kraya does this same 5-minute refresh.
   */
  function startAutoRefresh() {
    // Clear any existing timer
    if (refreshTimer) {
      clearInterval(refreshTimer);
    }

    refreshTimer = setInterval(async function () {
      if (!isLoggedIn || !orgId) return;

      console.log("[OceanCRM:MAIN] Auto-refresh starting...");

      try {
        // Reload leads
        await loadAllLeads(orgId);

        // Rebuild buckets
        await buildBuckets();

        // Re-apply current filter
        if (activeFilter !== "all-chats") {
          rebuildChatList(activeFilter);
          // Phase 4: injectChatBadges() will be called here
        }

        // Re-hide native filters (WA can re-add them after SPA navigation)
        removeNativeFilters();

        // Update navbar counts (already done in buildBuckets, but ensure)
        renderStageTabs();
        renderFilterTabs();

        console.log("[OceanCRM:MAIN] Auto-refresh complete");
      } catch (err) {
        console.error("[OceanCRM:MAIN] Auto-refresh failed:", err);
      }
    }, REFRESH_INTERVAL_MS);

    console.log(
      "[OceanCRM:MAIN] Auto-refresh started (every " +
        REFRESH_INTERVAL_MS / 60000 +
        " min)",
    );
  }

  // ================================================================
  // SECTION 7: WPP REQUEST HANDLER
  // ================================================================

  /**
   * Wait for WPP to be ready before accepting requests.
   * wa-inject.js sets window.WPP when loaded.
   */

  function checkWPPReady() {
    if (typeof window.WPP !== "undefined" && window.WPP.isReady) {
      wppReady = true;
      console.log("[OceanCRM:MAIN] WPP.js is ready");
      window.dispatchEvent(
        new CustomEvent("ocean-wpp-ready", { detail: { ready: true } }),
      );
      // Signal UI init (Phase 2)
      window.dispatchEvent(new CustomEvent("ocean-wpp-ready-ui-init"));
      return;
    }
    // Retry every 500ms
    setTimeout(checkWPPReady, 500);
  }

  checkWPPReady();

  // Wait for jQuery, then WPP ready, then init UI
  waitForJQuery(function () {
    if (wppReady) {
      initUI();
    } else {
      window.addEventListener(
        "ocean-wpp-ready-ui-init",
        function () {
          initUI();
        },
        { once: true },
      );
    }
  });

  /**
   * Handle requests from ISOLATED world (content.js).
   * Each request has: { id, type, payload }
   * We respond with: { id, type, result, error }
   */
  window.addEventListener("ocean-request", async function (event) {
    const { id, type, payload } = event.detail;

    if (!wppReady) {
      sendResponse(id, type, null, "WPP not ready yet");
      return;
    }

    try {
      let result = null;

      switch (type) {
        case "getChatList": {
          const chats = await WPP.chat.list(payload || {});
          // Return simplified chat data to keep the message small
          result = chats.map(function (chat) {
            return {
              id: {
                user: chat.id.user,
                server: chat.id.server,
                _serialized: chat.id._serialized,
              },
              name: chat.name || chat.formattedTitle || "",
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              archive: chat.archive || false,
              timestamp: chat.t || 0,
            };
          });
          break;
        }

        case "findChat": {
          result = await WPP.chat.find(payload.phone);
          if (result) {
            result = {
              id: {
                user: result.id.user,
                server: result.id.server,
                _serialized: result.id._serialized,
              },
              name: result.name || result.formattedTitle || "",
            };
          }
          break;
        }

        case "getContact": {
          const contact = await WPP.contact.get(payload.contactId);
          result = contact
            ? {
                id: contact.id._serialized,
                name: contact.name || contact.pushname || "",
                shortName: contact.shortName || "",
                number: contact.id.user,
              }
            : null;
          break;
        }

        case "checkContactExists": {
          const exists = await WPP.contact.queryExists(payload.phone);
          result = exists
            ? {
                exists: true,
                jid: exists.wid._serialized,
                user: exists.wid.user,
              }
            : { exists: false };
          break;
        }

        case "getMyId": {
          const myId = WPP.conn.getMyUserId();
          result = { user: myId.user, _serialized: myId._serialized };
          break;
        }

        case "isWPPReady": {
          result = { ready: wppReady };
          break;
        }

        case "openChat": {
          // Open chat in WhatsApp's native UI
          try {
            if (WPP.chat.openChatBottom) {
              await WPP.chat.openChatBottom(payload.chatId);
            } else if (WPP.chat.openChatAt) {
              await WPP.chat.openChatAt(payload.chatId);
            } else {
              var chatModel = await WPP.chat.get(payload.chatId);
              if (chatModel) {
                await WPP.chat.openChatFromUnread(payload.chatId);
              }
            }
            result = { opened: true };
          } catch (e) {
            // Absolute fallback: URL hash navigation
            var phone = payload.chatId.split("@")[0];
            window.location.hash = "#/chat/" + phone;
            result = { opened: true, method: "hash" };
          }
          break;
        }

        case "getChatListEnriched": {
          // Like getChatList but includes last message body
          const chats = await WPP.chat.list(payload || {});
          result = [];
          for (var i = 0; i < chats.length; i++) {
            var chat = chats[i];
            var lastMsg = "";
            var lastMsgType = "";
            try {
              var msgs =
                chat.msgs && chat.msgs.getModelsArray
                  ? chat.msgs.getModelsArray()
                  : [];
              if (msgs.length > 0) {
                var last = msgs[msgs.length - 1];
                lastMsg = last.body || last.caption || "";
                lastMsgType = last.type || "chat";
                // Truncate long messages
                if (lastMsg.length > 100)
                  lastMsg = lastMsg.substring(0, 100) + "...";
              }
            } catch (e) {
              // Ignore message extraction errors
            }
            result.push({
              id: {
                user: chat.id.user,
                server: chat.id.server,
                _serialized: chat.id._serialized,
              },
              name: chat.name || chat.formattedTitle || "",
              isGroup: chat.isGroup || false,
              unreadCount: chat.unreadCount || 0,
              archive: chat.archive || false,
              timestamp: chat.t || 0,
              lastMessageBody: lastMsg,
              lastMessageType: lastMsgType,
            });
          }
          break;
        }

        default:
          sendResponse(id, type, null, "Unknown request type: " + type);
          return;
      }

      sendResponse(id, type, result, null);
    } catch (err) {
      console.error("[OceanCRM:MAIN] Error handling " + type, err);
      sendResponse(id, type, null, err.message || String(err));
    }
  });

  /**
   * Send response back to ISOLATED world.
   */
  function sendResponse(id, type, result, error) {
    window.dispatchEvent(
      new CustomEvent("ocean-response", {
        detail: { id: id, type: type, result: result, error: error },
      }),
    );
  }

  console.log(
    "[OceanCRM:MAIN] Main world script loaded, waiting for dependencies...",
  );
})();

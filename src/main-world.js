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
  var selectedChat = null;

  // Data (populated by Phase 3)
  var leads = {}; // leads[chatId] = leadObject
  var buckets = {}; // buckets[slug] = [chatIds]
  var stages = []; // [{id, stage, slug, order, color, is_default}]
  var allChatIds = []; // Master sorted chat ID list
  var userData = null; // User/org data object

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
   * Initialize Phase 2 UI rendering.
   *
   * Called after both jQuery and WPP are ready.
   * Phase 3 will extend this with data loading.
   */
  function initUI() {
    console.log("[OceanCRM:MAIN] Initializing UI...");

    // Detect WA version (needs WPP ready)
    detectWAVersion();

    // Render navbar (initially with empty data — Phase 3 will populate)
    renderNavbar({
      stages: stages,
      buckets: buckets,
      version: "1.2.0",
    });

    // Window resize handler (debounced)
    var resizeTimer = null;
    $(window).on("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        adjustLayout();
        updateScrollButtonVisibility();
      }, 150);
    });

    console.log("[OceanCRM:MAIN] UI initialized (awaiting data from Phase 3)");
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

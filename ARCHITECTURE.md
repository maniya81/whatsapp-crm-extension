# System Architecture Diagram

## Component Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        WhatsApp Web Page                         │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                      Stage Bar (Fixed Top)                  │ │
│  │  [NEW LEAD (3)] [DISCUSSION (2)] [WON (1)] [LOST (5)]     │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                   │
│  ┌──────────────┐  ┌─────────────────────────────────────────┐ │
│  │              │  │                                          │ │
│  │   WhatsApp   │  │      WhatsApp Chat Area                 │ │
│  │   Chat List  │  │                                          │ │
│  │              │  │                                          │ │
│  │  Chat 1 ●    │  │                                          │ │
│  │  Chat 2      │  │                                          │ │
│  │  Chat 3 ●    │  │                                          │ │
│  │  Chat 4      │  │                                          │ │
│  │              │  │                                          │ │
│  │              │  │                                          │ │
│  └──────────────┘  └─────────────────────────────────────────┘ │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

                              ▲
                              │
                    Injected by React App
                              │
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     React Extension App                          │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    LeadContext Provider                  │   │
│  │                                                           │   │
│  │  State:                                                   │   │
│  │  - leads: Lead[]                                         │   │
│  │  - stages: Stage[]                                       │   │
│  │  - activeStage: string | null                            │   │
│  │  - loading: boolean                                      │   │
│  │  - error: string | null                                  │   │
│  │                                                           │   │
│  │  ┌──────────────────────────────────────────────────┐   │   │
│  │  │              ExtensionContent                     │   │   │
│  │  │                                                    │   │   │
│  │  │  Uses: useLeads(orgId)                           │   │   │
│  │  │                                                    │   │   │
│  │  │  ┌─────────────────┐  ┌────────────────────────┐ │   │   │
│  │  │  │   StageBar      │  │  ChatHighlighter       │ │   │   │
│  │  │  │                 │  │                        │ │   │   │
│  │  │  │ - Renders       │  │ - Watches DOM         │ │   │   │
│  │  │  │   stage pills   │  │ - Matches phones      │ │   │   │
│  │  │  │ - Shows counts  │  │ - Adds highlights     │ │   │   │
│  │  │  │ - Click handler │  │ - Debounced observer  │ │   │   │
│  │  │  └─────────────────┘  └────────────────────────┘ │   │   │
│  │  │                                                    │   │   │
│  │  └──────────────────────────────────────────────────┘   │   │
│  │                                                           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

                              ▲
                              │
                         API Calls via
                    chrome.runtime.sendMessage
                              │
                              ▼

┌─────────────────────────────────────────────────────────────────┐
│                  Background Service Worker                       │
│                                                                   │
│  chrome.runtime.onMessage.addListener()                         │
│                                                                   │
│  Handles:                                                        │
│  - getStages  → GET /v1/lead/stage/                            │
│  - getLeads   → GET /v1/lead?page_size=1000                    │
│  - createLead → POST /v1/lead                                  │
│  - getOrgs    → GET /v1/org/current                            │
│                                                                   │
│  Authentication:                                                 │
│  - Reads cookies (access_token_cookie)                          │
│  - Adds x-access-token header                                   │
│  - Adds x-org-id header                                         │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘

                              │
                              ▼

┌─────────────────────────────────────────────────────────────────┐
│                    OceanCRM API Server                           │
│              https://crm.oceantechnolab.com/api                  │
│                                                                   │
│  Endpoints:                                                      │
│  • GET  /v1/lead/stage/         (List stages)                  │
│  • GET  /v1/lead                (List leads)                   │
│  • POST /v1/lead                (Create lead)                  │
│  • GET  /v1/org/current         (Get organizations)            │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Data Flow Sequence

### 1. Extension Load
```
User opens WhatsApp Web
    ↓
Content script injected
    ↓
React app mounts
    ↓
Reads orgId from chrome.storage
    ↓
useLeads hook triggers
    ↓
Parallel API calls:
  - fetchStages(orgId)
  - fetchLeads(orgId)
    ↓
Background worker handles requests
    ↓
Data returned to React app
    ↓
LeadContext updated
    ↓
StageBar renders with stages
ChatHighlighter starts watching DOM
```

### 2. User Clicks Stage
```
User clicks "DISCUSSION" stage
    ↓
setActiveStage("DISCUSSION")
    ↓
useLeads recalculates filteredLeads (useMemo)
    ↓
ChatHighlighter receives new filteredLeads
    ↓
Creates phone number Set from filtered leads
    ↓
Scans WhatsApp chat DOM
    ↓
Matches phone numbers (normalized)
    ↓
Adds badges and highlights to matching chats
```

### 3. WhatsApp Chat List Changes
```
WhatsApp adds/removes chat
    ↓
MutationObserver detects change
    ↓
Debounce waits 300ms
    ↓
Highlight function runs
    ↓
Re-scans chat list
    ↓
Updates highlights based on current filter
```

## Phone Number Matching Logic

```
Lead Business Mobile: "+1 (555) 123-4567"
                ↓
        normalizePhone()
                ↓
         "+15551234567"
                ↓
        Store in Set

WhatsApp data-id: "15551234567@c.us"
                ↓
        Extract: "15551234567"
                ↓
        normalizePhone()
                ↓
         "15551234567"
                ↓
        Check in Set
                ↓
        Match: "+15551234567" OR "15551234567"
                ↓
         ✓ Highlight chat
```

## Memory Usage

```
Component Tree:
  LeadProvider (Context)
    └─ ExtensionContent
         ├─ StageBar (renders only)
         └─ ChatHighlighter (null render, side effects only)

State:
  - leads: ~100-1000 items
  - stages: ~5-10 items
  - activeStage: string
  - leadsByStage: grouped map (memoized)
  - filteredLeads: subset array (memoized)

DOM Observers:
  - 1 MutationObserver on chat list container
  - Debounced to 300ms
  - Auto cleanup on unmount
```

## Build Output

```
dist/
├── content.js           (142 KB) ← React app bundle
├── content-legacy.js    (29 KB)  ← Original vanilla JS
├── background.js        (1.6 KB) ← Service worker
├── styles.css           (13 KB)  ← All styles
├── manifest.json        (792 B)  ← Extension config
└── icons/
    └── icon-128.png     (133 KB) ← Extension icon
```

## Performance Characteristics

- **Initial Load**: ~150 KB JavaScript
- **Memory**: ~2-5 MB (including React runtime)
- **CPU**: Minimal (debounced observers)
- **API Calls**: 2 on load, 0 during operation
- **DOM Updates**: Only on chat list changes
- **Re-renders**: Prevented by useMemo optimization

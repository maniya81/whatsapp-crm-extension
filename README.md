# OceanCRM WhatsApp Extension

## What it does

- Adds a small CRM panel inside WhatsApp Web
- Reads CRM session cookies from localhost
- Lets you select an organization and create a lead
- Quick capture: paste WhatsApp chat or email text to auto-fill fields
- **NEW:** Stage grouping and filtering system with visual lead matching

## Features

### Stage Bar & Lead Filtering
- Horizontal stage bar at the top of WhatsApp UI
- Shows all CRM stages with lead counts
- Click a stage to filter leads
- Visual highlighting of matching WhatsApp chats
- Real-time synchronization with CRM data

### Supported Stages
- **WON** (Green)
- **LOST** (Red)
- **DISCUSSION** (Blue)
- **NEW LEAD** (Orange)
- Custom stages (Gray)

## Build & Installation

### Prerequisites
- Node.js 16+ and npm
- Chrome browser
- Access to OceanCRM account

### Build Steps

1. Clone the repository:
```bash
git clone https://github.com/maniya81/whatsapp-crm-extension.git
cd whatsapp-crm-extension
```

2. Install dependencies:
```bash
npm install
```

3. Build the extension:
```bash
npm run build
```

This creates a `dist/` folder with the compiled extension.

### Load unpacked

1. Open Chrome Extensions (chrome://extensions)
2. Enable Developer mode
3. Click "Load unpacked" and select the `dist` folder
4. Navigate to https://web.whatsapp.com

## Development

### Development Mode
```bash
npm run dev
```
This watches for file changes and rebuilds automatically.

### Clean Build
```bash
npm run clean
npm run build
```

## Architecture

```
src/
├── services/
│   └── api.ts              # API calls for stages and leads
├── context/
│   └── LeadContext.tsx     # Global state management
├── hooks/
│   └── useLeads.ts         # Lead management hook
├── components/
│   ├── StageBar.tsx        # Stage filter bar component
│   └── ChatHighlighter.tsx # WhatsApp chat highlighting
├── ExtensionApp.tsx        # Main React app
├── content-entry.tsx       # React injection point
├── content.js              # Legacy content script
└── background.js           # Service worker for API calls
```

## How It Works

1. **Extension loads** on WhatsApp Web
2. **Fetches stages and leads** from OceanCRM API
3. **Groups leads by stage** using memoized logic
4. **Renders stage bar** at top of screen
5. **Monitors WhatsApp chat list** for changes
6. **Highlights matching chats** based on selected stage filter

## API Endpoints

- `GET /v1/lead/stage/` - Fetch stages
- `GET /v1/lead?page_size=500` - Fetch leads (max 500 per API limit)
- `POST /v1/lead` - Create new lead

## Notes

- Make sure you are logged into the CRM web app in the same browser.
- API base default is https://crm.oceantechnolab.com/api
- If CSRF is enabled, the extension sends X-CSRF-Token automatically.
- Stage filtering is performed client-side for performance
- Phone number matching is normalized (removes spaces, brackets, keeps +)
- Lead limit: Maximum 500 leads fetched per request (API enforced)

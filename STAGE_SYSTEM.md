# Stage Grouping & Filtering System Documentation

## Overview

The stage grouping and filtering system adds a visual layer to WhatsApp Web that helps users filter and manage leads based on their CRM stage. The system integrates seamlessly with WhatsApp's UI and provides real-time synchronization with OceanCRM.

## Architecture

### Component Hierarchy

```
ExtensionApp (LeadProvider)
├── StageBar
└── ChatHighlighter
```

### Data Flow

1. **Initialization**
   - Extension loads on WhatsApp Web
   - Retrieves `orgId` from Chrome storage
   - Triggers `useLeads` hook

2. **Data Fetching**
   - Parallel API calls to:
     - `/v1/lead/stage/` (fetch stages)
     - `/v1/lead?page_size=1000` (fetch leads)
   - Data stored in LeadContext

3. **Grouping**
   - Leads grouped by stage using `useMemo`
   - Efficient O(n) grouping algorithm
   - Map structure: `{ stageName: [lead1, lead2, ...] }`

4. **Filtering**
   - User clicks stage button
   - `activeStage` state updated
   - `filteredLeads` computed via `useMemo`
   - ChatHighlighter receives filtered leads

5. **Highlighting**
   - ChatHighlighter extracts phone numbers from WhatsApp DOM
   - Normalizes phone numbers (removes spaces, brackets)
   - Compares with filtered leads' mobile numbers
   - Adds visual indicators to matching chats

## Key Features

### Performance Optimizations

1. **Memoization**
   - `useMemo` for lead grouping
   - `useMemo` for filtered leads
   - Prevents unnecessary re-computation

2. **Debouncing**
   - DOM observer debounced to 300ms
   - Reduces CPU usage during rapid UI changes

3. **Single API Fetch**
   - Data fetched once on mount
   - No repeated API calls on stage clicks

4. **Efficient Matching**
   - Phone numbers stored in Set for O(1) lookup
   - Only updates changed chat items

### Phone Number Normalization

Both WhatsApp numbers and CRM numbers are normalized using:
```javascript
normalizePhone(phone) {
  return phone.replace(/[\s\(\)\-]/g, "");
}
```

Keeps `+` prefix intact for international numbers.

### Stage Colors

| Stage        | Color   | Hex Code |
|--------------|---------|----------|
| WON          | Green   | #198f51  |
| LOST         | Red     | #b00020  |
| DISCUSSION   | Blue    | #1565c0  |
| NEW LEAD     | Orange  | #f9a825  |
| Others       | Gray    | #7b6f63  |

## User Interface

### Stage Bar
- Fixed position at top of screen
- Horizontal scrollable layout
- Shows stage name + count badge
- Active stage has colored background
- Hover effects for better UX

### Chat Highlighting
- Small blue dot on matching chats
- Subtle background tint (rgba blue)
- Automatically updates on stage selection
- Removes highlights when stage deselected

## API Integration

### Background Script
The extension uses Chrome's service worker pattern:

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getLeads") {
    // Fetch leads with orgId
  }
  if (message.type === "getStages") {
    // Fetch stages with orgId
  }
});
```

### API Service
TypeScript service with type-safe interfaces:

```typescript
export interface Lead {
  id: string;
  stage: string;
  business: {
    mobile: string;
  };
}
```

## Dark Mode Support

The StageBar component automatically detects WhatsApp's dark mode:

- Watches for `body.dark` class
- Updates background colors accordingly
- MutationObserver tracks theme changes

## Error Handling

- Graceful degradation if API fails
- Console warnings for missing orgId
- No blocking errors - extension continues working

## Browser Compatibility

- Chrome 88+ (Manifest V3)
- Edge 88+
- Opera 74+

## Future Enhancements

Potential improvements:
- [ ] Add search/filter within stage
- [ ] Show lead preview on hover
- [ ] Add stage transition actions
- [ ] Persist active stage preference
- [ ] Add keyboard shortcuts
- [ ] Export filtered leads

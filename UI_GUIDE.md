# Visual UI Guide

## Expected UI Layout

### Stage Bar (Top of Screen)
```
┌─────────────────────────────────────────────────────────────────┐
│  [NEW LEAD (3)] [DISCUSSION (2)] [WON (1)] [LOST (5)] [...] ►  │
└─────────────────────────────────────────────────────────────────┘
```

### Stage Button States

#### Inactive Stage
```
┌──────────────────┐
│ DISCUSSION  (2)  │  ← Gray background, colored badge
└──────────────────┘
```

#### Active Stage
```
┌──────────────────┐
│ DISCUSSION  (2)  │  ← Colored background (blue), white text
└──────────────────┘
   ▲ 2px border
```

### WhatsApp Chat List with Highlights

```
WhatsApp Chat List
├── Chat 1 (Matching)         ● ← Blue dot indicator
│   ├── Name: John Doe        │ ← Subtle blue tint background
│   └── Last message...       │
│
├── Chat 2 (Not Matching)
│   ├── Name: Jane Smith
│   └── Last message...
│
└── Chat 3 (Matching)         ●
    ├── Name: Bob Wilson      │ ← Subtle blue tint background
    └── Last message...       │
```

## Stage Colors Reference

### Visual Color Samples

```
WON         ████ #198f51 (Green)
LOST        ████ #b00020 (Red)
DISCUSSION  ████ #1565c0 (Blue)
NEW LEAD    ████ #f9a825 (Orange)
DEFAULT     ████ #7b6f63 (Gray)
```

## Interaction Flow

### 1. No Stage Selected (Default)
- All stage buttons are gray/neutral
- All leads are visible (no filtering)
- No chat highlights

### 2. Stage Selected
- Selected stage button changes to colored background
- Other stages remain gray
- Only chats matching selected stage get highlighted
- Blue dot appears on matching chats
- Subtle background tint on matching chat items

### 3. Stage Deselected (Click Same Stage)
- Returns to default state
- Highlights removed
- All leads visible again

## Dark Mode Appearance

### Light Mode
- Stage bar: `rgba(255, 255, 255, 0.95)` with white background
- Border: Light gray `#e0e0e0`
- Inactive buttons: Light gray `#f5f5f5`

### Dark Mode
- Stage bar: `rgba(17, 27, 33, 0.95)` with dark background
- Border: Dark gray `#2a3942`
- Inactive buttons: Dark gray `#202c33`
- Automatically detected via `body.dark` class

## Responsive Behavior

- Stage bar scrolls horizontally if too many stages
- Maintains fixed position at top
- Doesn't interfere with WhatsApp's native UI
- Z-index: 200 (above chat but below modals)

## Accessibility

- Keyboard navigable stage buttons
- Clear visual focus states
- High contrast for stage colors
- Screen reader friendly structure

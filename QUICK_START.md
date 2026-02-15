# Quick Start Guide

## For End Users

### Installation (5 minutes)

1. **Download or Build**
   ```bash
   # If you have the source code:
   npm install
   npm run build
   ```

2. **Load Extension**
   - Open Chrome and go to `chrome://extensions`
   - Enable "Developer mode" (toggle in top-right)
   - Click "Load unpacked"
   - Select the `dist/` folder
   - Extension installed! ✓

3. **Setup CRM Access**
   - Open https://crm.oceantechnolab.com
   - Log in to your account
   - Keep this tab open (for authentication)

4. **Use on WhatsApp**
   - Navigate to https://web.whatsapp.com
   - Wait for WhatsApp to load
   - Stage bar appears at the top automatically!

### Using the Stage Filter

#### View All Stages
When you first load WhatsApp, you'll see a horizontal bar at the top:
```
[NEW LEAD (3)] [DISCUSSION (2)] [WON (1)] [LOST (5)]
```

Each button shows:
- **Stage name** (e.g., "NEW LEAD")
- **Lead count** in a colored badge (e.g., "(3)")

#### Filter by Stage
1. Click any stage button (e.g., "DISCUSSION")
2. The button turns blue/colored
3. Matching WhatsApp chats get a blue dot: ●
4. Only leads in that stage are highlighted

#### Clear Filter
- Click the same stage button again
- Everything returns to normal
- All leads visible again

#### Stage Colors
- 🟢 **WON** = Green
- 🔴 **LOST** = Red
- 🔵 **DISCUSSION** = Blue
- 🟠 **NEW LEAD** = Orange
- ⚫ **Others** = Gray

### Highlighted Chats

When a stage is selected, matching chats show:
- Small blue dot (●) on the right
- Subtle blue background tint
- Easy to spot in the chat list

### Dark Mode

The extension automatically detects WhatsApp's theme:
- Light mode: White stage bar
- Dark mode: Dark stage bar
- No configuration needed!

### Troubleshooting

#### Nothing works / Extension completely broken?
**CRITICAL**: CSP Violation Error
```
EvalError: Evaluating a string as JavaScript violates CSP directive 'unsafe-eval'
```

This has been fixed! If you see this error:
1. Pull latest code: `git pull`
2. Clean install: `rm -rf node_modules dist && npm install`
3. Rebuild: `npm run build`
4. Remove extension from Chrome completely
5. Restart Chrome
6. Load extension from fresh `dist/` folder
7. Hard refresh WhatsApp Web (Ctrl+Shift+R)

**What was wrong**: Webpack was using eval() which violates Chrome extension security policy.  
**Fixed by**: Adding `devtool: false` to webpack.config.js

#### Stage bar not showing?
1. Check if you're logged into CRM
2. Refresh WhatsApp Web page
3. Check browser console for errors
4. Verify orgId is saved (see Developer section)

#### API Error: "page_size should be less than or equal to 500"?
This has been fixed! If you see this error:
1. Pull latest code: `git pull`
2. Rebuild: `npm run build`
3. Reload extension in Chrome
4. The extension now fetches max 500 leads (API limit)

#### TypeError: "Cannot read properties of undefined (reading 'toUpperCase')"?
This has been fixed! The error occurred when stages had undefined names.
1. Pull latest code: `git pull`
2. Rebuild: `npm run build`
3. Reload extension in Chrome
4. Stages without names are now safely skipped

#### Multiple UIM tree roots error?
This has been fixed! The extension now prevents duplicate React mounting.
1. Ensure you have the latest version
2. Both content-legacy.js and content.js were loading (now fixed)
3. Global initialization flag added
4. Rebuild and reload the extension
5. The error should no longer appear

#### Storage mutation event handler error?
This was caused by duplicate script loading (now fixed).
1. Only content.js now loads (content-legacy.js removed)
2. Pull latest and rebuild
3. Extension should work without storage errors

#### No highlights appearing?
1. Click a stage to activate filter
2. Check if phone numbers match CRM data
3. Verify leads have phone numbers in CRM
4. Try refreshing the page

#### Extension not loading?
1. Check extension is enabled in `chrome://extensions`
2. Verify you selected the `dist/` folder
3. Check for any error messages
4. Try rebuilding: `npm run build`

## For Developers

### Quick Development Setup

```bash
# Clone and setup
git clone <repository>
cd whatsapp-crm-extension
npm install

# Development mode (auto-rebuild)
npm run dev

# Load in Chrome
# 1. Go to chrome://extensions
# 2. Enable Developer mode
# 3. Load unpacked -> select dist/
# 4. Make changes in src/
# 5. Extension auto-rebuilds
# 6. Click refresh icon in chrome://extensions
```

### Project Structure
```
src/
├── ExtensionApp.tsx          # Main app
├── content-entry.tsx         # Entry point
├── components/
│   ├── StageBar.tsx          # Stage filter UI
│   └── ChatHighlighter.tsx   # Highlight logic
├── context/
│   └── LeadContext.tsx       # Global state
├── hooks/
│   └── useLeads.ts           # Lead management
├── services/
│   └── api.ts                # API calls
└── background.js             # Service worker
```

### Making Changes

1. **Edit TypeScript/React files** in `src/`
2. **Webpack auto-rebuilds** (if using `npm run dev`)
3. **Reload extension** in Chrome
4. **Test on WhatsApp Web**

### Adding a New Feature

Example: Add a search box in stage bar

```tsx
// src/components/StageBar.tsx

export function StageBar({ leadsByStage }: StageBarProps) {
  const [search, setSearch] = useState('');
  
  return (
    <div style={{...}}>
      <input 
        type="text" 
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search stages..."
      />
      
      {stages
        .filter(s => s.name.includes(search))
        .map(stage => (...))}
    </div>
  );
}
```

Rebuild and test!

### Debugging Tips

1. **Check console logs:**
   ```
   F12 → Console tab
   Look for [OceanCRM] logs
   ```

2. **Check extension background:**
   ```
   chrome://extensions
   Click "service worker" link
   View background script logs
   ```

3. **Check API responses:**
   ```
   Network tab → Filter: XHR
   Check API call responses
   ```

4. **Check state:**
   ```tsx
   // Add temporary logging in component
   console.log('Leads:', leads);
   console.log('Active stage:', activeStage);
   ```

### Common Issues

**TypeScript errors?**
```bash
# Check tsconfig.json
# Make sure types are correct
# Run: npm run build
```

**Webpack errors?**
```bash
# Check webpack.config.js
# Verify all imports are correct
# Delete node_modules and reinstall
```

**React not updating?**
```tsx
// Make sure you're using state correctly
const [value, setValue] = useState(initial);

// Not: value = newValue
// Use: setValue(newValue)
```

### Performance Testing

Monitor performance:
```javascript
console.time('Lead grouping');
const grouped = groupLeadsByStage(leads);
console.timeEnd('Lead grouping');
// Should be < 10ms for 1000 leads
```

### Building for Production

```bash
# Clean build
npm run clean
npm run build

# Check dist/ folder
ls -lh dist/

# Should see:
# - content.js (~142 KB)
# - background.js (~1.6 KB)
# - styles.css (~13 KB)
# - manifest.json
# - icons/
```

### API Testing

Test API calls manually:
```javascript
// In browser console on CRM site
fetch('https://crm.oceantechnolab.com/api/v1/lead/stage/', {
  headers: {
    'x-org-id': 'YOUR_ORG_ID',
    'x-access-token': 'YOUR_TOKEN'
  }
})
.then(r => r.json())
.then(console.log);
```

## Tips & Tricks

### Keyboard Shortcuts
Currently not implemented, but could be added:
- `Ctrl+1` → Select first stage
- `Ctrl+2` → Select second stage
- `Ctrl+0` → Clear filter
- `Ctrl+F` → Focus search (future feature)

### Performance Tips
- Extension fetches data once on load
- No repeated API calls during usage
- Memoization prevents unnecessary updates
- Debouncing reduces DOM operations

### Best Practices
1. Always log into CRM before using
2. Keep CRM tab open in background
3. Refresh if data seems stale
4. Report bugs with console logs

## Need Help?

1. Check documentation:
   - README.md (overview)
   - ARCHITECTURE.md (technical)
   - STAGE_SYSTEM.md (implementation)
   - UI_GUIDE.md (design)

2. Check console for errors (F12)

3. Verify extension is loaded and enabled

4. Check GitHub issues for known problems

5. Contact support with:
   - Browser version
   - Extension version
   - Console error logs
   - Steps to reproduce issue

## What's Next?

Potential future features:
- [ ] Search within stages
- [ ] Lead preview on hover
- [ ] Stage transition actions
- [ ] Export filtered leads
- [ ] Custom stage colors
- [ ] Lead statistics
- [ ] Keyboard shortcuts
- [ ] Lead notes/comments

Want to contribute? Check the repository for contribution guidelines!

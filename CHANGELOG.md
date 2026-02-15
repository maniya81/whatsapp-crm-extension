# Changelog

## [Unreleased] - 2026-02-15

### Fixed
- **CSP Violation (CRITICAL)**: Fixed Content Security Policy error breaking entire extension
  - Error: `"EvalError: Evaluating a string as JavaScript violates CSP directive 'unsafe-eval'"`
  - File: `webpack.config.js` - Added `devtool: false` and `mode: 'production'`
  - Impact: Extension now loads without CSP violations, bundle has no eval() calls

- **Double Initialization**: Added global flag to prevent script running multiple times
  - Error: Multiple initialization attempts causing UIM errors
  - File: `src/content-entry.tsx` - Added `__OCRM_INITIALIZED__` global flag
  - Impact: Script only initializes once, preventing duplicate React roots

- **API Error**: Changed `page_size` from 1000 to 500 to comply with API limit
  - Error: `"Input should be less than or equal to 500"`
  - File: `src/background.js` line 99
  - Impact: Extension now fetches up to 500 leads successfully

- **React Mounting Error**: Added guard to prevent duplicate React root mounting
  - Error: `"Attempting to set multiple UIM tree roots"`
  - File: `src/content-entry.tsx` lines 29-34
  - Impact: No more WhatsApp UIM conflicts, React app mounts only once

- **Undefined Stage Name Error**: Added null/undefined checks for stage names
  - Error: `"Cannot read properties of undefined (reading 'toUpperCase')"`
  - File: `src/components/StageBar.tsx` lines 17-20, 76-88
  - Impact: Stages without names are safely skipped with warning

- **Duplicate Script Loading**: Removed content-legacy.js from manifest
  - Error: Multiple UIM roots and storage mutation errors
  - File: `manifest.json` line 22
  - Impact: Only content.js loads, preventing initialization conflicts

### Notes
- If you need more than 500 leads, pagination would need to be implemented
- The extension now properly checks for existing React root before mounting
- Stages without names are logged as warnings and skipped in UI
- Webpack now builds without eval for CSP compliance
- Global initialization flag provides additional protection against double mounting

## [0.1.0] - 2026-02-15

### Added
- Stage grouping and filtering system
- Horizontal stage bar with colored badges
- Real-time chat highlighting based on filtered leads
- Dark mode support with automatic detection
- Performance optimizations (memoization, debouncing)
- TypeScript + React architecture
- Comprehensive documentation

### Technical Details
- React 18 + TypeScript
- Context API for state management
- Webpack 5 build system
- Manifest V3 Chrome extension
- Zero security vulnerabilities (CodeQL verified)

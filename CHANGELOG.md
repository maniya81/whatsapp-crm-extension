# Changelog

## [Unreleased] - 2026-02-15

### Fixed
- **API Error**: Changed `page_size` from 1000 to 500 to comply with API limit
  - Error: `"Input should be less than or equal to 500"`
  - File: `src/background.js` line 99
  - Impact: Extension now fetches up to 500 leads successfully

- **React Mounting Error**: Added guard to prevent duplicate React root mounting
  - Error: `"Attempting to set multiple UIM tree roots"`
  - File: `src/content-entry.tsx` lines 29-34
  - Impact: No more WhatsApp UIM conflicts, React app mounts only once

### Notes
- If you need more than 500 leads, pagination would need to be implemented
- The extension now properly checks for existing React root before mounting

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

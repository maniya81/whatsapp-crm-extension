# OceanCRM WhatsApp Extension

## What it does

- Adds a small CRM panel inside WhatsApp Web
- Reads CRM session cookies from localhost
- Lets you select an organization and create a lead
- Quick capture: paste WhatsApp chat or email text to auto-fill fields

## Load unpacked

1. Open Chrome Extensions (chrome://extensions)
2. Enable Developer mode
3. Click Load unpacked and select this folder

## Notes

- Make sure you are logged into the CRM web app in the same browser.
- API base default is http://localhost:8000/api
- If CSRF is enabled, the extension sends X-CSRF-Token automatically.

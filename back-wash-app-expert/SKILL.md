---
name: back-wash-app-expert
description: Expert assistant for the "back-wash-test" application. Use when building, debugging, extending, or maintaining this React/Node.js CIP (Cleaning In Place) recording system.
---

# Back-Wash App Expert Guide

This skill makes you an expert on the "back-wash-test" system, a full-stack application for recording CIP processes.

## 🚀 Quick Navigation
- **Architecture & Tech Stack:** [architecture.md](references/architecture.md)
- **Database Schema & SQL:** [database.md](references/database.md)
- **CIP Steps & Business Logic:** [cip_logic.md](references/cip_logic.md)

## 🛠 Common Workflows

### 1. Running the Application
Always run both client and server:
- **Server:** `cd server && node index.js` (Port 3001)
- **Client:** `cd client && npm run dev` (Port 5173, exposes to network)

### 2. Debugging Data Issues
If steps are not saving:
1. Check `server/server.log` (if redirected) or console output.
2. Verify `server/cip_database.sqlite` permissions.
3. Check `client/src/components/Logbook.tsx` -> `saveStepData` function.

### 3. Modifying CIP Steps
To add or change steps, edit `client/src/data/steps.ts`. The UI will automatically reflect changes.

## 📏 Standards & Patterns
- **Dates:** Server uses Swedish locale (`sv-SE`) for ISO-like strings.
- **Validation:** pH is invalid if `< 4` or `> 10`.
- **API:** Use `http://<hostname>:3001/api/...` for requests.
- **Images:** Stored in `server/uploads/` and served statically.

## 🧪 Testing Logic
Before committing changes, verify:
1. **Login:** PIN `1234` works for default operators.
2. **Step Progress:** Start -> Save Data -> Stop -> Next step auto-expands.
3. **Webhook:** Verify n8n receives the POST request on step completion.

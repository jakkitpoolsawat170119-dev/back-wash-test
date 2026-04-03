---
name: cip-orange-line2
description: Expert assistant for the Orange Line 2 CIP (Cleaning In Place) recording system. Use when the user needs to manage, fix, or run the CIP recording application located in the "back wash test" folder.
---

# CIP Orange Line 2 System Management

This skill contains the procedural knowledge to manage, troubleshoot, and operate the CIP (Cleaning In Place) recording system for Orange Line 2.

## Project Structure
- **Frontend (Client):** Located in `client/` (React + Vite + TypeScript)
  - Port: `5173`
  - URL (Local): `http://localhost:5173`
- **Backend (Server):** Located in `server/` (Node.js + Express + SQLite)
  - Port: `3001`
  - Database: `cip_database.sqlite`
  - Uploads: `server/uploads/`

## Running the System

To start the system, run these commands in separate terminal windows:

### 1. Start Server
```bash
cd "/Users/myjakkit/Downloads/back wash test/server" && node index.js
```
Wait for: "Connected to the SQLite database."

### 2. Start Client (Mobile Accessible)
```bash
cd "/Users/myjakkit/Downloads/back wash test/client" && npm run dev
```
Wait for: "Network: http://<IP_ADDRESS>:5173/"

## Network Connectivity (Mobile Access)
If the mobile app cannot connect:
1. Check the local IP address: `ipconfig getifaddr en0`
2. Update the mobile browser URL to: `http://<NEW_IP>:5173`
3. Ensure the Server (Port 3001) is also running and accessible.

## Key Logic & Rules
- **Login PIN:** Default for all operators is `1234` (stored in `operators` table).
- **pH Warning:** If pH > 10 or < 4, the input field turns red (Validation in `Logbook.tsx`).
- **Smart Collapsible:** The app auto-expands the current active step and collapses finished ones.
- **Finish Batch:** Batch status is updated to 'completed' and `end_time` is set via `/api/batches/finish`.

## Troubleshooting
- **Port in use:** Run `lsof -ti:5173,3001 | xargs kill -9` to clear hung processes.
- **White Screen:** Check if `npm install` has been run in both folders.
- **Data not saving:** Ensure the `server/cip_database.sqlite` has write permissions.

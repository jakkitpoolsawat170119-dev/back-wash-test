# Application Architecture

## Tech Stack
- **Frontend:** React (TypeScript) + Vite
  - **Styling:** CSS Modules (`App.module.css`)
  - **State:** Local React State (useState)
  - **Icons:** SVG Sprite in `public/icons.svg`
- **Backend:** Node.js + Express
  - **Database:** SQLite (`sqlite3` driver)
  - **File Uploads:** Multer (local storage in `uploads/`)
  - **HTTP Client:** Axios (for Webhooks)
- **Integrations:**
  - **n8n:** Webhook triggers on step completion.

## Project Structure
```text
/
├── client/          # Vite + React source
│   └── src/
│       ├── components/ # Login, Logbook, History
│       └── data/      # steps.ts (Core Logic)
└── server/          # Express + SQLite
    ├── index.js     # Main server file
    └── uploads/     # Image storage
```

## API Endpoints

### Auth
- `POST /api/login`: Validates operator name and PIN.
- `GET /api/operators`: Lists all operator names.

### Batches
- `POST /api/batches/start`: Starts a new CIP batch.
- `POST /api/batches/finish`: Completes a batch (sets `end_time` and `status`).
- `GET /api/batches`: Lists all batches.
- `GET /api/batches/:id`: Gets batch details with all step logs.
- `POST /api/batches/reset`: **Destructive** - Clears all history.

### Steps
- `POST /api/steps/log`: Records or updates data for a specific step. Supports multipart/form-data for images.

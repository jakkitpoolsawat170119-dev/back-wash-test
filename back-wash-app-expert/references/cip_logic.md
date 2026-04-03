# CIP Logic & Steps

## Business Rules

### 1. Step Validation
- **pH Level:** Normal range is `4.0 - 10.0`. 
  - If `pH < 4` or `pH > 10`, the UI shows a red warning and a ⚠️ symbol.
- **Auto-Expansion:** When a step's `Stop` button is clicked, the `expandedStep` state in `Logbook.tsx` increments to the next step ID.

### 2. Step Synchronization
- Data is saved on `onBlur` for text/number inputs.
- Images are saved immediately upon selection.
- Webhook (`n8n`) is triggered **only once** per step, when `end_time` is first recorded.

### 3. Date Formatting
- Server-side formatting: `new Date().toLocaleString('sv-SE').replace(' ', 'T')`
- Client-side formatting for display: `new Date(timeStr).toLocaleTimeString('th-TH')`

## Step Definitions (Overview)
The system tracks **27 steps** defined in `client/src/data/steps.ts`.

| Step Range | Category | Key Actions |
|------------|----------|-------------|
| 1-2 | Preparation | Spraying, Scrubbing |
| 3-5 | Chemical (MIP) | Heating (80°C), Circulating, Soaking |
| 6 | Rinse | Spraying to remove chemicals |
| 7-9 | Boiling | Boiling water circulation |
| 10-20 | **Backwash** | Multiple cycles (10 times) |
| 21-27 | Filling | Water flow through tanks to filling line |

*Note: Steps 10-20 are repetitive "Backwash" cycles.*

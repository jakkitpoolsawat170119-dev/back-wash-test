# Database Schema (SQLite)

The database is located at `server/cip_database.sqlite`.

## Tables

### `operators`
Stores authorized staff members.
- `id`: INTEGER PRIMARY KEY
- `name`: TEXT
- `pin`: TEXT (Default: '1234')

### `cip_batches`
Tracks each CIP session.
- `id`: INTEGER PRIMARY KEY
- `operator_name`: TEXT
- `start_time`: TEXT (ISO format)
- `end_time`: TEXT (ISO format)
- `line_name`: TEXT (Default: 'Orange Line 2')
- `status`: TEXT ('in_progress', 'completed')

### `cip_step_logs`
Records data for each individual step within a batch.
- `id`: INTEGER PRIMARY KEY
- `batch_id`: INTEGER (FK)
- `step_number`: INTEGER
- `step_description`: TEXT
- `start_time`: TEXT
- `end_time`: TEXT
- `pressure`: REAL
- `brix`: REAL
- `ph`: REAL
- `remarks`: TEXT
- `image_path`: TEXT
- **Unique Constraint:** `(batch_id, step_number)`

## Useful Queries

### Check Recent Logs
```sql
SELECT * FROM cip_step_logs ORDER BY id DESC LIMIT 5;
```

### Fix Stuck Batch
```sql
UPDATE cip_batches SET status = 'completed', end_time = CURRENT_TIMESTAMP WHERE id = ?;
```

### Reset All Data
```sql
DELETE FROM cip_step_logs;
DELETE FROM cip_batches;
```

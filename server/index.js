require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3001;

// Configure Multer for local storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = 'uploads';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

app.use(cors());
app.use(express.json());

// Request logger for debugging
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

app.use('/uploads', express.static('uploads'));

const dbPath = path.resolve(__dirname, 'cip_database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    createTables();
  }
});

function createTables() {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS operators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      pin TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cip_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      operator_name TEXT NOT NULL,
      start_time TEXT,
      end_time TEXT,
      line_name TEXT DEFAULT 'Orange Line 2',
      status TEXT DEFAULT 'in_progress'
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cip_step_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER,
      step_number INTEGER,
      step_description TEXT,
      start_time TEXT,
      end_time TEXT,
      pressure REAL,
      brix REAL,
      ph REAL,
      remarks TEXT,
      image_path TEXT,
      UNIQUE(batch_id, step_number),
      FOREIGN KEY (batch_id) REFERENCES cip_batches (id)
    )`);

    // Reset and Re-insert operators to fix typos and duplicates
    db.run("DELETE FROM operators", (err) => {
      if (!err) {
        const insertOp = db.prepare("INSERT OR IGNORE INTO operators (name, pin) VALUES (?, ?)");
        insertOp.run("นาย จักรกฤษ พูลสวัสดิ์", "1234");
        insertOp.run("นาย พัฒพริศ อ่ำอยู่", "1234");
        insertOp.run("นาย อนวัตน์ สุวรรณวงค์", "1234");
        insertOp.finalize();
        console.log("Operators list reset and updated.");
      }
    });
  });
}

// Function to send data to n8n Webhook
const sendToN8n = async (data) => {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL; 
  if (!n8nWebhookUrl) return;
  
  try {
    console.log(`[Webhook] Sending Step ${data.stepNumber}`);
    await axios.post(n8nWebhookUrl, data);
  } catch (error) {
    console.error('[Webhook Error]', error.message);
  }
};

app.post('/api/steps/log', upload.single('image'), (req, res) => {
  const { batchId, stepNumber, stepDescription, startTime, endTime, pressure, brix, ph, remarks } = req.body;
  const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
  
  // LOG EVERYTHING to console for debugging
  console.log(`>>> DATA RECEIVED: Batch ${batchId} | Step ${stepNumber} | P: ${pressure} | B: ${brix} | pH: ${ph} | Img: ${imagePath}`);

  const fmtStart = startTime ? new Date(startTime).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T') : null;
  const fmtEnd = endTime ? new Date(endTime).toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T') : null;

  db.get("SELECT id, image_path, pressure, brix, ph, remarks, end_time FROM cip_step_logs WHERE batch_id = ? AND step_number = ?", [batchId, stepNumber], (err, row) => {
    if (row) {
      const updPressure = (pressure !== undefined && pressure !== '') ? pressure : row.pressure;
      const updBrix = (brix !== undefined && brix !== '') ? brix : row.brix;
      const updPh = (ph !== undefined && ph !== '') ? ph : row.ph;
      const updRemarks = (remarks !== undefined && remarks !== '') ? remarks : row.remarks;
      const updImagePath = imagePath || row.image_path;

      const query = `UPDATE cip_step_logs SET 
        start_time = COALESCE(?, start_time), 
        end_time = COALESCE(?, end_time),
        pressure = ?, 
        brix = ?, 
        ph = ?, 
        remarks = ?, 
        image_path = ?
        WHERE id = ?`;
      
      db.run(query, [fmtStart, fmtEnd, updPressure, updBrix, updPh, updRemarks, updImagePath, row.id], async (err) => {
          if (err) return res.status(500).json({ error: err.message });
          if (endTime && !row.end_time) {
            db.get("SELECT operator_name FROM cip_batches WHERE id = ?", [batchId], (err, batch) => {
                const publicUrl = `https://${req.get('host')}`;
                console.log(`[Webhook] Sending Step ${stepNumber} to n8n with UPDATED data...`);
                sendToN8n({ 
                  type: 'step_completed', 
                  batchId, 
                  operatorName: batch ? batch.operator_name : 'Unknown',
                  stepNumber, 
                  stepDescription, 
                  startTime: fmtStart || row.start_time, 
                  endTime: fmtEnd, 
                  pressure: updPressure, 
                  brix: updBrix, 
                  ph: updPh, 
                  remarks: updRemarks,
                  image: updImagePath ? `${publicUrl}${updImagePath}` : null
                });
            });
          }

          res.json({ success: true, imagePath: updImagePath });
        }
      );
    } else {
      db.run(`INSERT INTO cip_step_logs (batch_id, step_number, step_description, start_time, end_time, pressure, brix, ph, remarks, image_path) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [batchId, stepNumber, stepDescription, fmtStart, fmtEnd, pressure, brix, ph, remarks, imagePath],
        async (err) => {
          if (err) return res.status(500).json({ error: err.message });
          
          if (endTime) {
            db.get("SELECT operator_name FROM cip_batches WHERE id = ?", [batchId], (err, batch) => {
                const publicUrl = `https://${req.get('host')}`;
                sendToN8n({ 
                  type: 'step_completed', 
                  batchId, 
                  operatorName: batch ? batch.operator_name : 'Unknown',
                  stepNumber, 
                  stepDescription, 
                  startTime: fmtStart, 
                  endTime: fmtEnd, 
                  pressure, brix, ph, remarks,
                  image: imagePath ? `${publicUrl}${imagePath}` : null
                });
            });
          }
          res.json({ success: true, imagePath });
        }
      );
    }
  });
});

app.get('/api/batches', (req, res) => {
  db.all("SELECT * FROM cip_batches ORDER BY id DESC", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/batches/:id', (req, res) => {
  const batchId = req.params.id;
  db.get("SELECT * FROM cip_batches WHERE id = ?", [batchId], (err, batch) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!batch) return res.status(404).json({ message: "Batch not found" });

    db.all("SELECT * FROM cip_step_logs WHERE batch_id = ? ORDER BY step_number ASC", [batchId], (err, steps) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ...batch, steps });
    });
  });
});

app.post('/api/batches/reset', (req, res) => {
  db.serialize(() => {
    db.run("DELETE FROM cip_step_logs", (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run("DELETE FROM cip_batches", (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: "History cleared successfully" });
      });
    });
  });
});

app.post('/api/login', (req, res) => {
    const { name, pin } = req.body;
    db.get("SELECT * FROM operators WHERE name = ? AND pin = ?", [name, pin], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) {
        res.json({ success: true, operator: row.name });
      } else {
        res.status(401).json({ success: false, message: "Invalid PIN" });
      }
    });
  });

app.get('/api/operators', (req, res) => {
  db.all("SELECT name FROM operators", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows.map(r => r.name));
  });
});
  
app.post('/api/batches/start', (req, res) => {
    const { operatorName } = req.body;
    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T'); 
    db.run("INSERT INTO cip_batches (operator_name, start_time) VALUES (?, ?)", [operatorName, now], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ batchId: this.lastID });
    });
  });

app.post('/api/batches/finish', (req, res) => {
  const { batchId } = req.body;
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
  db.run("UPDATE cip_batches SET end_time = ?, status = 'completed' WHERE id = ?", [now, batchId], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, endTime: now });
  });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port}`);
});

-- Database schema for cuboid-track

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'intern',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id),
  date TEXT NOT NULL, -- YYYY-MM-DD
  tasks_done TEXT NOT NULL,
  blockers TEXT DEFAULT '',
  next_plan TEXT DEFAULT '',
  submitted_at DATETIME NOT NULL,
  is_late INTEGER NOT NULL DEFAULT 0, -- 0: on-time, 1: late
  kpi_status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'pass' | 'fail' | 'needs_improvement'
  leader_comment TEXT DEFAULT '',
  UNIQUE(user_id, date)
);

-- Seed initial interns if empty
INSERT OR IGNORE INTO users (id, name, role) VALUES
  ('intern_1', 'Nguyễn Văn A', 'intern'),
  ('intern_2', 'Trần Thị B', 'intern'),
  ('intern_3', 'Lê Văn C', 'intern');

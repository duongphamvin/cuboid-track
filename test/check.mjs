import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'

// 1. Verify schema runs cleanly on SQLite
const db = new DatabaseSync(':memory:')
const schema = readFileSync('./schema.sql', 'utf8')
db.exec(schema)

// 2. Verify initial users seeded
const users = db.prepare('SELECT * FROM users').all()
assert.equal(users.length >= 3, true, 'Seed users must exist')

// 3. Verify insert and query report
const insertReport = db.prepare(`
  INSERT INTO reports (user_id, date, tasks_done, submitted_at, is_late, kpi_status)
  VALUES (?, ?, ?, ?, ?, ?)
`)
insertReport.run('intern_1', '2026-10-27', 'Fix UI bug', '2026-10-27 16:45', 0, 'pending')

const report = db.prepare('SELECT * FROM reports WHERE user_id = ? AND date = ?').get('intern_1', '2026-10-27')
assert.equal(report.tasks_done, 'Fix UI bug')
assert.equal(report.is_late, 0)
assert.equal(report.kpi_status, 'pending')

// 4. Verify unique constraint per user per date
assert.throws(() => {
  insertReport.run('intern_1', '2026-10-27', 'Duplicate', '2026-10-27 17:00', 0, 'pending')
}, /UNIQUE constraint failed/)

console.log('All tests passed cleanly.')

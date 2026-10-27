import { Hono } from 'hono'
import { handle } from 'hono/cloudflare-pages'

type Bindings = {
  DB: D1Database
  LEADER_PIN?: string
  DEADLINE_HOUR?: string
  DEADLINE_MINUTE?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Helper: Vietnam timezone date & time
function getVNTime(): { dateStr: string; timeStr: string; isLate: boolean; hour: number; minute: number } {
  const now = new Date()
  const vnFormatted = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const parts: Record<string, string> = {}
  for (const p of vnFormatted) {
    parts[p.type] = p.value
  }

  const dateStr = `${parts.year}-${parts.month}-${parts.day}`
  const hour = parseInt(parts.hour, 10)
  const minute = parseInt(parts.minute, 10)
  const timeStr = `${parts.hour}:${parts.minute}`

  // Default deadline: 17:30 Vietnam time
  const isLate = hour > 17 || (hour === 17 && minute > 30)

  return { dateStr, timeStr, isLate, hour, minute }
}

// ----------------- API ROUTES -----------------

// 1. Get all interns
app.get('/api/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, role FROM users WHERE role = 'intern' ORDER BY name ASC"
  ).all()
  return c.json(results || [])
})

// 2. Add new intern (Leader only)
app.post('/api/users', async (c) => {
  const pin = c.req.header('x-leader-pin')
  const expectedPin = c.env.LEADER_PIN || '123456'
  if (pin !== expectedPin) {
    return c.json({ error: 'Mã PIN Leader không đúng' }, 401)
  }

  const body = await c.req.json<{ name?: string }>()
  const name = body.name?.trim()
  if (!name) {
    return c.json({ error: 'Tên không được để trống' }, 400)
  }

  const id = 'user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  await c.env.DB.prepare(
    "INSERT INTO users (id, name, role) VALUES (?, ?, 'intern')"
  ).bind(id, name).run()

  return c.json({ success: true, id, name })
})

// 3. Verify Leader PIN
app.post('/api/leader/verify-pin', async (c) => {
  const body = await c.req.json<{ pin?: string }>()
  const expectedPin = c.env.LEADER_PIN || '123456'
  if (body.pin === expectedPin) {
    return c.json({ valid: true })
  }
  return c.json({ valid: false, error: 'Mã PIN không chính xác' }, 401)
})

// 4. Get today's report of a user
app.get('/api/reports/today', async (c) => {
  const userId = c.req.query('user_id')
  if (!userId) return c.json({ error: 'Missing user_id' }, 400)

  const { dateStr } = getVNTime()
  const report = await c.env.DB.prepare(
    'SELECT * FROM reports WHERE user_id = ? AND date = ?'
  ).bind(userId, dateStr).first()

  return c.json({ date: dateStr, report: report || null })
})

// 5. Get report history of a user
app.get('/api/reports/history', async (c) => {
  const userId = c.req.query('user_id')
  if (!userId) return c.json({ error: 'Missing user_id' }, 400)

  const { results } = await c.env.DB.prepare(
    'SELECT * FROM reports WHERE user_id = ? ORDER BY date DESC LIMIT 15'
  ).bind(userId).all()

  return c.json(results || [])
})

// 6. Submit or Update today's report (Member)
app.post('/api/reports', async (c) => {
  const body = await c.req.json<{
    user_id?: string
    tasks_done?: string
    blockers?: string
    next_plan?: string
  }>()

  if (!body.user_id || !body.tasks_done?.trim()) {
    return c.json({ error: 'Vui lòng nhập công việc đã hoàn thành hôm nay' }, 400)
  }

  const { dateStr, timeStr, isLate } = getVNTime()
  const submittedAt = `${dateStr} ${timeStr}`

  // Check existing report for today
  const existing = await c.env.DB.prepare(
    'SELECT id, is_late, kpi_status FROM reports WHERE user_id = ? AND date = ?'
  ).bind(body.user_id, dateStr).first<{ id: number; is_late: number; kpi_status: string }>()

  if (existing) {
    // Update existing report, keep initial is_late status or update timestamp
    await c.env.DB.prepare(
      `UPDATE reports SET
        tasks_done = ?,
        blockers = ?,
        next_plan = ?,
        submitted_at = ?
       WHERE id = ?`
    ).bind(
      body.tasks_done.trim(),
      (body.blockers || '').trim(),
      (body.next_plan || '').trim(),
      submittedAt,
      existing.id
    ).run()

    return c.json({ success: true, updated: true, is_late: existing.is_late === 1 })
  } else {
    // Insert new report
    await c.env.DB.prepare(
      `INSERT INTO reports (user_id, date, tasks_done, blockers, next_plan, submitted_at, is_late, kpi_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).bind(
      body.user_id,
      dateStr,
      body.tasks_done.trim(),
      (body.blockers || '').trim(),
      (body.next_plan || '').trim(),
      submittedAt,
      isLate ? 1 : 0
    ).run()

    return c.json({ success: true, updated: false, is_late: isLate })
  }
})

// 7. Get leader daily overview
app.get('/api/leader/overview', async (c) => {
  const pin = c.req.header('x-leader-pin')
  const expectedPin = c.env.LEADER_PIN || '123456'
  if (pin !== expectedPin) {
    return c.json({ error: 'Chưa xác thực quyền Leader' }, 401)
  }

  const targetDate = c.req.query('date') || getVNTime().dateStr

  // Get all interns
  const { results: users } = await c.env.DB.prepare(
    "SELECT id, name FROM users WHERE role = 'intern' ORDER BY name ASC"
  ).all<{ id: string; name: string }>()

  // Get all reports for that date
  const { results: reports } = await c.env.DB.prepare(
    'SELECT * FROM reports WHERE date = ?'
  ).bind(targetDate).all<{
    id: number
    user_id: string
    date: string
    tasks_done: string
    blockers: string
    next_plan: string
    submitted_at: string
    is_late: number
    kpi_status: string
    leader_comment: string
  }>()

  const reportMap = new Map((reports || []).map((r) => [r.user_id, r]))

  const list = (users || []).map((u) => {
    const r = reportMap.get(u.id)
    return {
      user_id: u.id,
      user_name: u.name,
      report_id: r ? r.id : null,
      submitted: !!r,
      submitted_at: r ? r.submitted_at : null,
      is_late: r ? r.is_late === 1 : null,
      tasks_done: r ? r.tasks_done : '',
      blockers: r ? r.blockers : '',
      next_plan: r ? r.next_plan : '',
      kpi_status: r ? r.kpi_status : 'not_submitted',
      leader_comment: r ? r.leader_comment : '',
    }
  })

  return c.json({ date: targetDate, items: list })
})

// 8. Update KPI & feedback (Leader)
app.post('/api/leader/evaluate', async (c) => {
  const pin = c.req.header('x-leader-pin')
  const expectedPin = c.env.LEADER_PIN || '123456'
  if (pin !== expectedPin) {
    return c.json({ error: 'Chưa xác thực quyền Leader' }, 401)
  }

  const body = await c.req.json<{
    report_id?: number
    kpi_status?: string
    leader_comment?: string
  }>()

  if (!body.report_id) {
    return c.json({ error: 'Thiếu report_id' }, 400)
  }

  const validStatuses = ['pending', 'pass', 'fail', 'needs_improvement']
  const status = validStatuses.includes(body.kpi_status || '') ? body.kpi_status : 'pending'
  const comment = (body.leader_comment || '').trim()

  await c.env.DB.prepare(
    'UPDATE reports SET kpi_status = ?, leader_comment = ? WHERE id = ?'
  ).bind(status, comment, body.report_id).run()

  return c.json({ success: true })
})

// ----------------- HTML VIEWS -----------------

// Member View
app.get('/', (c) => {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cuboid Track - Báo cáo tiến độ</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col font-sans">
  <header class="bg-white border-b border-slate-200 sticky top-0 z-10">
    <div class="max-w-3xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center space-x-2">
        <span class="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-lg">C</span>
        <div>
          <h1 class="font-bold text-slate-900 leading-tight">Cuboid Track</h1>
          <p class="text-xs text-slate-500">Báo cáo tiến độ thực tập sinh</p>
        </div>
      </div>
      <div class="flex items-center space-x-3 text-sm">
        <div id="userHeaderBadge" class="hidden items-center space-x-2 bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-full font-medium">
          <span id="userNameDisplay">...</span>
          <button onclick="logoutUser()" title="Đổi tài khoản" class="text-slate-400 hover:text-red-500 text-xs ml-1 font-normal underline">Đổi</button>
        </div>
        <a href="/leader" class="text-slate-500 hover:text-indigo-600 text-xs px-2.5 py-1.5 rounded-md border border-slate-200 hover:border-indigo-200">Leader</a>
      </div>
    </div>
  </header>

  <main class="max-w-3xl mx-auto px-4 py-6 flex-1 w-full">
    <!-- Screen 1: Pick User -->
    <div id="pickUserSection" class="hidden bg-white p-6 rounded-xl shadow-sm border border-slate-200 text-center max-w-md mx-auto mt-8">
      <h2 class="text-lg font-bold text-slate-900 mb-2">Chọn tên thực tập sinh</h2>
      <p class="text-xs text-slate-500 mb-6">Chọn tên của bạn một lần duy nhất. Trình duyệt sẽ tự nhớ cho các lần tiếp theo.</p>

      <div class="space-y-4 text-left">
        <div>
          <label class="block text-xs font-semibold text-slate-700 mb-1">Danh sách thành viên</label>
          <select id="userSelectDropdown" class="w-full border border-slate-300 rounded-lg p-2.5 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none">
            <option value="">-- Đang tải danh sách... --</option>
          </select>
        </div>
        <button onclick="confirmSelectedUser()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg text-sm transition">
          Bắt đầu nộp báo cáo
        </button>
      </div>
    </div>

    <!-- Screen 2: Report Form -->
    <div id="reportSection" class="hidden space-y-6">
      <!-- Status Notice -->
      <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="text-xs text-slate-500">Hôm nay</div>
          <div id="todayDateLabel" class="font-bold text-slate-900 text-base">...</div>
        </div>
        <div class="text-right">
          <div class="text-xs text-slate-500">Hạn chót hàng ngày: <span class="font-semibold text-slate-700">17:30</span></div>
          <div id="deadlineStatusBadge" class="inline-block mt-1 text-xs px-2.5 py-1 rounded-full font-medium">...</div>
        </div>
      </div>

      <!-- KPI Status Banner if already submitted -->
      <div id="kpiReviewCard" class="hidden bg-white p-4 rounded-xl shadow-sm border border-slate-200">
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs font-bold uppercase tracking-wider text-slate-500">Đánh giá từ Leader</span>
          <span id="kpiBadge" class="text-xs px-2.5 py-1 rounded-full font-bold">...</span>
        </div>
        <div id="kpiCommentBox" class="text-sm text-slate-700 bg-slate-50 p-3 rounded-lg border border-slate-100">
          Chưa có nhận xét.
        </div>
      </div>

      <!-- Form Box -->
      <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <div class="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
          <h2 class="font-bold text-slate-900" id="formTitle">Nhập tiến độ công việc</h2>
          <span id="submissionTag" class="hidden text-xs px-2.5 py-1 rounded-md font-medium"></span>
        </div>

        <form id="reportForm" onsubmit="submitReport(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">
              1. Công việc đã hoàn thành hôm nay <span class="text-red-500">*</span>
            </label>
            <textarea id="tasksDoneInput" rows="4" required placeholder="- Hoàn thành task X&#10;- Đọc tài liệu Y&#10;- Họp thảo luận cùng team..." class="w-full border border-slate-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"></textarea>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">
              2. Khó khăn / Vướng mắc (nếu có)
            </label>
            <textarea id="blockersInput" rows="2" placeholder="Gặp lỗi ở module..., cần leader hỗ trợ..." class="w-full border border-slate-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"></textarea>
          </div>

          <div>
            <label class="block text-xs font-semibold text-slate-700 mb-1">
              3. Kế hoạch ngày mai
            </label>
            <textarea id="nextPlanInput" rows="2" placeholder="- Tiếp tục sửa lỗi&#10;- Tích hợp API..." class="w-full border border-slate-300 rounded-lg p-3 text-sm focus:ring-2 focus:ring-indigo-500 focus:outline-none"></textarea>
          </div>

          <div class="pt-2">
            <button type="submit" id="submitBtn" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 rounded-lg text-sm transition">
              Nộp báo cáo
            </button>
          </div>
        </form>
      </div>

      <!-- History -->
      <div class="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
        <h3 class="font-bold text-slate-900 text-sm mb-4">Lịch sử nộp gần đây</h3>
        <div id="historyList" class="space-y-3">
          <div class="text-xs text-slate-400">Đang tải lịch sử...</div>
        </div>
      </div>
    </div>
  </main>

  <footer class="border-t border-slate-200 py-4 text-center text-xs text-slate-400">
    Cuboid Track • Hệ thống báo cáo nội bộ
  </footer>

  <script>
    let currentUser = null;
    let usersList = [];

    async function init() {
      await loadUsers();
      const savedUserId = localStorage.getItem('cuboid_user_id');
      if (savedUserId) {
        currentUser = usersList.find(u => u.id === savedUserId);
      }

      if (!currentUser) {
        showUserPicker();
      } else {
        showReportForm();
      }
    }

    async function loadUsers() {
      try {
        const res = await fetch('/api/users');
        usersList = await res.json();
        const select = document.getElementById('userSelectDropdown');
        select.innerHTML = '<option value="">-- Chọn tên của bạn --</option>' +
          usersList.map(u => \`<option value="\${u.id}">\${u.name}</option>\`).join('');
      } catch (e) {
        alert('Không thể tải danh sách thành viên');
      }
    }

    function showUserPicker() {
      document.getElementById('pickUserSection').classList.remove('hidden');
      document.getElementById('reportSection').classList.add('hidden');
      document.getElementById('userHeaderBadge').classList.add('hidden');
    }

    function confirmSelectedUser() {
      const select = document.getElementById('userSelectDropdown');
      const val = select.value;
      if (!val) {
        alert('Vui lòng chọn tên của bạn');
        return;
      }
      localStorage.setItem('cuboid_user_id', val);
      currentUser = usersList.find(u => u.id === val);
      showReportForm();
    }

    function logoutUser() {
      if (confirm('Bạn muốn đổi sang tài khoản khác?')) {
        localStorage.removeItem('cuboid_user_id');
        currentUser = null;
        showUserPicker();
      }
    }

    async function showReportForm() {
      document.getElementById('pickUserSection').classList.add('hidden');
      document.getElementById('reportSection').classList.remove('hidden');
      document.getElementById('userHeaderBadge').classList.remove('hidden');
      document.getElementById('userHeaderBadge').classList.add('flex');
      document.getElementById('userNameDisplay').innerText = currentUser.name;

      // Update date and deadline status
      const now = new Date();
      const dateStr = now.toLocaleDateString('vi-VN', { weekday: 'long', year: 'numeric', month: 'numeric', day: 'numeric' });
      document.getElementById('todayDateLabel').innerText = dateStr;

      const hour = now.getHours();
      const minute = now.getMinutes();
      const isPast = hour > 17 || (hour === 17 && minute > 30);
      const deadlineBadge = document.getElementById('deadlineStatusBadge');
      if (isPast) {
        deadlineBadge.className = 'inline-block mt-1 text-xs px-2.5 py-1 rounded-full font-medium bg-amber-100 text-amber-800';
        deadlineBadge.innerText = 'Đã quá 17:30 (Sẽ tính nộp trễ)';
      } else {
        deadlineBadge.className = 'inline-block mt-1 text-xs px-2.5 py-1 rounded-full font-medium bg-emerald-100 text-emerald-800';
        deadlineBadge.innerText = 'Đang trong hạn nộp';
      }

      await loadTodayReport();
      await loadHistory();
    }

    async function loadTodayReport() {
      try {
        const res = await fetch(\`/api/reports/today?user_id=\${currentUser.id}\`);
        const data = await res.json();
        const r = data.report;
        const tag = document.getElementById('submissionTag');
        const submitBtn = document.getElementById('submitBtn');

        if (r) {
          document.getElementById('tasksDoneInput').value = r.tasks_done || '';
          document.getElementById('blockersInput').value = r.blockers || '';
          document.getElementById('nextPlanInput').value = r.next_plan || '';

          tag.classList.remove('hidden');
          if (r.is_late) {
            tag.className = 'text-xs px-2.5 py-1 rounded-md font-medium bg-amber-100 text-amber-800';
            tag.innerText = \`Đã nộp lúc \${r.submitted_at.split(' ')[1] || ''} (Nộp trễ)\`;
          } else {
            tag.className = 'text-xs px-2.5 py-1 rounded-md font-medium bg-emerald-100 text-emerald-800';
            tag.innerText = \`Đã nộp lúc \${r.submitted_at.split(' ')[1] || ''} (Đúng hạn)\`;
          }
          submitBtn.innerText = 'Cập nhật lại báo cáo';

          // Show KPI card
          const kpiCard = document.getElementById('kpiReviewCard');
          const kpiBadge = document.getElementById('kpiBadge');
          const kpiComment = document.getElementById('kpiCommentBox');
          kpiCard.classList.remove('hidden');

          const statusMap = {
            pending: { text: 'Chờ Leader duyệt KPI', cls: 'bg-slate-100 text-slate-700' },
            pass: { text: 'KPI ĐẠT', cls: 'bg-emerald-100 text-emerald-800' },
            needs_improvement: { text: 'CẦN CẢI THIỆN', cls: 'bg-amber-100 text-amber-800' },
            fail: { text: 'KPI CHƯA ĐẠT', cls: 'bg-rose-100 text-rose-800' }
          };
          const st = statusMap[r.kpi_status] || statusMap.pending;
          kpiBadge.className = \`text-xs px-2.5 py-1 rounded-full font-bold \${st.cls}\`;
          kpiBadge.innerText = st.text;
          kpiComment.innerText = r.leader_comment ? \`" \${r.leader_comment} "\` : 'Chưa có nhận xét từ leader.';
        } else {
          tag.classList.add('hidden');
          document.getElementById('kpiReviewCard').classList.add('hidden');
          submitBtn.innerText = 'Nộp báo cáo tiến độ';
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function submitReport(e) {
      e.preventDefault();
      const tasksDone = document.getElementById('tasksDoneInput').value.trim();
      const blockers = document.getElementById('blockersInput').value.trim();
      const nextPlan = document.getElementById('nextPlanInput').value.trim();

      if (!tasksDone) {
        alert('Vui lòng nhập công việc đã hoàn thành!');
        return;
      }

      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.innerText = 'Đang lưu...';

      try {
        const res = await fetch('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: currentUser.id,
            tasks_done: tasksDone,
            blockers: blockers,
            next_plan: nextPlan
          })
        });
        const data = await res.json();
        if (data.error) {
          alert(data.error);
        } else {
          alert(data.updated ? 'Đã cập nhật báo cáo hôm nay!' : 'Đã nộp báo cáo thành công!');
          await loadTodayReport();
          await loadHistory();
        }
      } catch (err) {
        alert('Lỗi kết nối máy chủ!');
      } finally {
        btn.disabled = false;
      }
    }

    async function loadHistory() {
      try {
        const res = await fetch(\`/api/reports/history?user_id=\${currentUser.id}\`);
        const list = await res.json();
        const container = document.getElementById('historyList');

        if (!list || list.length === 0) {
          container.innerHTML = '<div class="text-xs text-slate-400">Chưa có báo cáo nào trước đây.</div>';
          return;
        }

        const statusMap = {
          pending: { text: 'Chờ duyệt', cls: 'bg-slate-100 text-slate-600' },
          pass: { text: 'Đạt', cls: 'bg-emerald-100 text-emerald-800' },
          needs_improvement: { text: 'Cần cải thiện', cls: 'bg-amber-100 text-amber-800' },
          fail: { text: 'Chưa đạt', cls: 'bg-rose-100 text-rose-800' }
        };

        container.innerHTML = list.map(item => {
          const st = statusMap[item.kpi_status] || statusMap.pending;
          const lateBadge = item.is_late ? '<span class="text-[10px] bg-amber-50 text-amber-700 px-1.5 py-0.5 rounded border border-amber-200">Trễ</span>' : '<span class="text-[10px] bg-emerald-50 text-emerald-700 px-1.5 py-0.5 rounded border border-emerald-200">Đúng hạn</span>';
          return \`
            <div class="p-3 border border-slate-100 rounded-lg bg-slate-50 text-xs">
              <div class="flex items-center justify-between mb-1.5">
                <span class="font-bold text-slate-800">\${item.date}</span>
                <div class="flex items-center space-x-1.5">
                  \${lateBadge}
                  <span class="px-2 py-0.5 rounded font-medium \${st.cls}">\${st.text}</span>
                </div>
              </div>
              <div class="text-slate-700 whitespace-pre-line mb-1 line-clamp-2"><strong>Đã làm:</strong> \${item.tasks_done}</div>
              \${item.leader_comment ? \`<div class="text-indigo-600 italic bg-white p-1.5 rounded border border-indigo-50 mt-1">Leader: "\${item.leader_comment}"</div>\` : ''}
            </div>
          \`;
        }).join('');
      } catch (e) {
        console.error(e);
      }
    }

    init();
  </script>
</body>
</html>`
  return c.html(html)
})

// Leader View
app.get('/leader', (c) => {
  const html = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cuboid Track - Quản trị Leader</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-50 text-slate-800 min-h-screen flex flex-col font-sans">
  <header class="bg-white border-b border-slate-200 sticky top-0 z-10">
    <div class="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
      <div class="flex items-center space-x-2">
        <span class="w-8 h-8 rounded-lg bg-slate-900 flex items-center justify-center text-white font-bold text-lg">L</span>
        <div>
          <h1 class="font-bold text-slate-900 leading-tight">Cuboid Track Leader</h1>
          <p class="text-xs text-slate-500">Kiểm tra tiến độ & Đánh giá KPI</p>
        </div>
      </div>
      <div class="flex items-center space-x-3 text-sm">
        <a href="/" class="text-slate-600 hover:text-indigo-600 text-xs px-2.5 py-1.5 rounded-md border border-slate-200">Về trang Member</a>
        <button id="logoutBtn" onclick="leaderLogout()" class="hidden text-red-600 hover:text-red-700 text-xs px-2.5 py-1.5 rounded-md border border-red-200 hover:bg-red-50">Đăng xuất</button>
      </div>
    </div>
  </header>

  <main class="max-w-5xl mx-auto px-4 py-6 flex-1 w-full">
    <!-- Screen 1: Enter Leader PIN -->
    <div id="pinSection" class="bg-white p-6 rounded-xl shadow-sm border border-slate-200 max-w-sm mx-auto mt-12 text-center">
      <div class="w-12 h-12 bg-slate-100 text-slate-700 rounded-full flex items-center justify-center mx-auto mb-3 font-bold text-xl">🔒</div>
      <h2 class="font-bold text-slate-900 text-base mb-1">Xác thực quyền Leader</h2>
      <p class="text-xs text-slate-500 mb-4">Nhập mã PIN để truy cập bảng kiểm tra KPI</p>

      <form onsubmit="verifyPin(event)" class="space-y-3">
        <input type="password" id="pinInput" placeholder="Nhập mã PIN..." required class="w-full border border-slate-300 rounded-lg p-2.5 text-center text-sm tracking-widest focus:ring-2 focus:ring-slate-900 focus:outline-none">
        <button type="submit" id="pinSubmitBtn" class="w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-2.5 rounded-lg text-sm transition">
          Xác nhận
        </button>
      </form>
    </div>

    <!-- Screen 2: Leader Dashboard -->
    <div id="dashboardSection" class="hidden space-y-6">
      <!-- Controls Bar -->
      <div class="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center space-x-2">
          <label class="text-xs font-semibold text-slate-700">Ngày kiểm tra:</label>
          <input type="date" id="selectedDateInput" onchange="loadDateOverview()" class="border border-slate-300 rounded-lg px-3 py-1.5 text-sm focus:ring-2 focus:ring-slate-900 focus:outline-none">
          <button onclick="setTodayDate()" class="text-xs bg-slate-100 hover:bg-slate-200 text-slate-700 px-2.5 py-1.5 rounded-lg font-medium">Hôm nay</button>
        </div>

        <div class="flex items-center space-x-2">
          <button onclick="openAddInternModal()" class="text-xs bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg font-medium transition">
            + Thêm thực tập sinh
          </button>
        </div>
      </div>

      <!-- Quick KPI Stats -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div class="text-xs text-slate-500">Tổng thực tập sinh</div>
          <div id="statTotal" class="text-2xl font-bold text-slate-900 mt-1">0</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div class="text-xs text-emerald-600 font-medium">Đã nộp đúng hạn</div>
          <div id="statOnTime" class="text-2xl font-bold text-emerald-600 mt-1">0</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div class="text-xs text-amber-600 font-medium">Nộp trễ hạn</div>
          <div id="statLate" class="text-2xl font-bold text-amber-600 mt-1">0</div>
        </div>
        <div class="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div class="text-xs text-rose-600 font-medium">Chưa nộp</div>
          <div id="statMissing" class="text-2xl font-bold text-rose-600 mt-1">0</div>
        </div>
      </div>

      <!-- Detail Intern List -->
      <div class="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
        <div class="p-4 border-b border-slate-100 font-bold text-slate-900 text-sm">
          Chi tiết báo cáo & Trạng thái KPI
        </div>
        <div id="internOverviewList" class="divide-y divide-slate-100">
          <div class="p-6 text-center text-xs text-slate-400">Đang tải dữ liệu...</div>
        </div>
      </div>
    </div>
  </main>

  <footer class="border-t border-slate-200 py-4 text-center text-xs text-slate-400">
    Cuboid Track • Bảng quản trị Leader
  </footer>

  <script>
    let leaderPin = sessionStorage.getItem('cuboid_leader_pin') || '';

    async function init() {
      if (leaderPin) {
        const isValid = await verifySavedPin(leaderPin);
        if (isValid) {
          showDashboard();
          return;
        }
      }
      showPinScreen();
    }

    function showPinScreen() {
      document.getElementById('pinSection').classList.remove('hidden');
      document.getElementById('dashboardSection').classList.add('hidden');
      document.getElementById('logoutBtn').classList.add('hidden');
    }

    function showDashboard() {
      document.getElementById('pinSection').classList.add('hidden');
      document.getElementById('dashboardSection').classList.remove('hidden');
      document.getElementById('logoutBtn').classList.remove('hidden');

      setTodayDate();
    }

    function setTodayDate() {
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      document.getElementById('selectedDateInput').value = \`\${yyyy}-\${mm}-\${dd}\`;
      loadDateOverview();
    }

    async function verifySavedPin(pin) {
      try {
        const res = await fetch('/api/leader/verify-pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin })
        });
        return res.ok;
      } catch (e) {
        return false;
      }
    }

    async function verifyPin(e) {
      e.preventDefault();
      const pin = document.getElementById('pinInput').value.trim();
      if (!pin) return;

      const btn = document.getElementById('pinSubmitBtn');
      btn.disabled = true;

      try {
        const ok = await verifySavedPin(pin);
        if (ok) {
          leaderPin = pin;
          sessionStorage.setItem('cuboid_leader_pin', pin);
          showDashboard();
        } else {
          alert('Mã PIN không chính xác!');
        }
      } finally {
        btn.disabled = false;
      }
    }

    function leaderLogout() {
      sessionStorage.removeItem('cuboid_leader_pin');
      leaderPin = '';
      showPinScreen();
    }

    async function loadDateOverview() {
      const date = document.getElementById('selectedDateInput').value;
      if (!date) return;

      const container = document.getElementById('internOverviewList');
      container.innerHTML = '<div class="p-6 text-center text-xs text-slate-400">Đang tải dữ liệu...</div>';

      try {
        const res = await fetch(\`/api/leader/overview?date=\${date}\`, {
          headers: { 'x-leader-pin': leaderPin }
        });
        if (res.status === 401) {
          leaderLogout();
          return;
        }

        const data = await res.json();
        const items = data.items || [];

        // Update stats
        let total = items.length;
        let onTime = items.filter(i => i.submitted && !i.is_late).length;
        let late = items.filter(i => i.submitted && i.is_late).length;
        let missing = items.filter(i => !i.submitted).length;

        document.getElementById('statTotal').innerText = total;
        document.getElementById('statOnTime').innerText = onTime;
        document.getElementById('statLate').innerText = late;
        document.getElementById('statMissing').innerText = missing;

        if (items.length === 0) {
          container.innerHTML = '<div class="p-6 text-center text-xs text-slate-400">Chưa có thực tập sinh nào trong danh sách.</div>';
          return;
        }

        container.innerHTML = items.map(item => {
          const submitBadge = !item.submitted
            ? '<span class="text-xs px-2.5 py-1 rounded-full font-medium bg-rose-100 text-rose-800">Chưa nộp</span>'
            : (item.is_late
                ? \`<span class="text-xs px-2.5 py-1 rounded-full font-medium bg-amber-100 text-amber-800">Nộp trễ (\${item.submitted_at ? item.submitted_at.split(' ')[1] : ''})</span>\`
                : \`<span class="text-xs px-2.5 py-1 rounded-full font-medium bg-emerald-100 text-emerald-800">Đúng hạn (\${item.submitted_at ? item.submitted_at.split(' ')[1] : ''})</span>\`
              );

          return \`
            <div class="p-5 flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div class="flex-1 space-y-2">
                <div class="flex items-center space-x-2">
                  <span class="font-bold text-slate-900">\${item.user_name}</span>
                  \${submitBadge}
                </div>

                \${item.submitted ? \`
                  <div class="bg-slate-50 p-3 rounded-lg border border-slate-100 text-xs space-y-1.5 text-slate-700">
                    <div><strong class="text-slate-900">Công việc đã làm:</strong> <span class="whitespace-pre-line">\${item.tasks_done}</span></div>
                    \${item.blockers ? \`<div><strong class="text-rose-700">Vướng mắc:</strong> <span class="whitespace-pre-line text-rose-800">\${item.blockers}</span></div>\` : ''}
                    \${item.next_plan ? \`<div><strong class="text-slate-900">Kế hoạch tiếp theo:</strong> <span class="whitespace-pre-line">\${item.next_plan}</span></div>\` : ''}
                  </div>
                \` : \`
                  <div class="text-xs text-slate-400 italic">Chưa có nội dung báo cáo trong ngày này.</div>
                \`}
              </div>

              \${item.submitted ? \`
                <div class="w-full md:w-72 bg-white p-3 rounded-lg border border-slate-200 text-xs space-y-2">
                  <div>
                    <label class="block font-semibold text-slate-700 mb-1">Đánh giá KPI:</label>
                    <select id="kpiSelect_\${item.report_id}" class="w-full border border-slate-300 rounded p-1.5 text-xs focus:ring-2 focus:ring-slate-900 focus:outline-none">
                      <option value="pending" \${item.kpi_status === 'pending' ? 'selected' : ''}>⏳ Chờ duyệt</option>
                      <option value="pass" \${item.kpi_status === 'pass' ? 'selected' : ''}>✅ Đạt</option>
                      <option value="needs_improvement" \${item.kpi_status === 'needs_improvement' ? 'selected' : ''}>⚠️ Cần cải thiện</option>
                      <option value="fail" \${item.kpi_status === 'fail' ? 'selected' : ''}>❌ Chưa đạt</option>
                    </select>
                  </div>

                  <div>
                    <label class="block font-semibold text-slate-700 mb-1">Ghi chú / Feedback:</label>
                    <input type="text" id="commentInput_\${item.report_id}" value="\${item.leader_comment || ''}" placeholder="Nhận xét cho bạn..." class="w-full border border-slate-300 rounded p-1.5 text-xs focus:ring-2 focus:ring-slate-900 focus:outline-none">
                  </div>

                  <button onclick="saveEvaluation(\${item.report_id})" class="w-full bg-slate-900 hover:bg-slate-800 text-white font-medium py-1.5 rounded text-xs transition">
                    Lưu đánh giá
                  </button>
                </div>
              \` : ''}
            </div>
          \`;
        }).join('');
      } catch (err) {
        console.error(err);
      }
    }

    async function saveEvaluation(reportId) {
      const select = document.getElementById(\`kpiSelect_\${reportId}\`);
      const commentInput = document.getElementById(\`commentInput_\${reportId}\`);
      const status = select.value;
      const comment = commentInput.value;

      try {
        const res = await fetch('/api/leader/evaluate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-leader-pin': leaderPin
          },
          body: JSON.stringify({
            report_id: reportId,
            kpi_status: status,
            leader_comment: comment
          })
        });
        const data = await res.json();
        if (data.error) {
          alert(data.error);
        } else {
          alert('Đã cập nhật đánh giá KPI!');
        }
      } catch (e) {
        alert('Lỗi cập nhật đánh giá');
      }
    }

    async function openAddInternModal() {
      const name = prompt('Nhập họ tên thực tập sinh mới:');
      if (!name || !name.trim()) return;

      try {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-leader-pin': leaderPin
          },
          body: JSON.stringify({ name: name.trim() })
        });
        const data = await res.json();
        if (data.error) {
          alert(data.error);
        } else {
          alert(\`Đã thêm thực tập sinh: \${name}\`);
          loadDateOverview();
        }
      } catch (e) {
        alert('Lỗi thêm thực tập sinh');
      }
    }

    init();
  </script>
</body>
</html>`
  return c.html(html)
})

export const onRequest = handle(app)

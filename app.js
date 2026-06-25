// ============================================================
// PartsAvenue Dashboard — основная логика
// ============================================================

// Состояние в памяти (после анлока)
const state = {
  token: null,            // расшифрованный PAT
  password: null,         // нужен для повторного шифрования при перезаписи (нет, не нужен — PUT через сам токен)
  monthsCache: {},        // "YYYY-MM" -> { sessions: [...] }
  monthsSha: {},          // "YYYY-MM" -> sha (для PUT)
  currentPeriod: "month", // today | yesterday | week | month | custom
  customDate: null,       // если currentPeriod === custom
  lockTimer: null,
};

// ============================================================
// LOCK SCREEN
// ============================================================
const lockScreen = document.getElementById("lockScreen");
const dashboard = document.getElementById("dashboard");
const pwdInput = document.getElementById("pwd");
const unlockBtn = document.getElementById("unlockBtn");
const lockErr = document.getElementById("lockErr");

async function tryUnlock() {
  const password = pwdInput.value;
  if (!password) {
    lockErr.textContent = "Введи пароль";
    return;
  }
  lockErr.textContent = "Расшифровка...";
  unlockBtn.disabled = true;

  try {
    const token = await decryptToken(CONFIG.ENCRYPTED_TOKEN, password);
    if (!token) {
      lockErr.textContent = "Неверный пароль";
      unlockBtn.disabled = false;
      return;
    }
    // Быстрый ping в GitHub — убедимся что токен ещё рабочий
    const ok = await pingGitHub(token);
    if (!ok) {
      lockErr.textContent = "Токен расшифрован, но GitHub его не принял (отозван?)";
      unlockBtn.disabled = false;
      return;
    }
    state.token = token;
    pwdInput.value = "";
    lockErr.textContent = "";
    unlockBtn.disabled = false;
    showDashboard();
  } catch (e) {
    lockErr.textContent = "Сбой: " + e.message;
    unlockBtn.disabled = false;
  }
}

unlockBtn.addEventListener("click", tryUnlock);
pwdInput.addEventListener("keydown", e => { if (e.key === "Enter") tryUnlock(); });

document.getElementById("lockBtn").addEventListener("click", () => {
  doLock();
});

function doLock() {
  state.token = null;
  state.monthsCache = {};
  state.monthsSha = {};
  if (state.lockTimer) { clearTimeout(state.lockTimer); state.lockTimer = null; }
  dashboard.style.display = "none";
  lockScreen.style.display = "flex";
  pwdInput.focus();
}

function resetLockTimer() {
  if (!CONFIG.AUTO_LOCK_SECONDS) return;
  if (state.lockTimer) clearTimeout(state.lockTimer);
  state.lockTimer = setTimeout(doLock, CONFIG.AUTO_LOCK_SECONDS * 1000);
}
["click", "keydown", "mousemove"].forEach(evt => {
  document.addEventListener(evt, () => { if (state.token) resetLockTimer(); });
});

// ============================================================
// GITHUB API
// ============================================================
async function pingGitHub(token) {
  try {
    const r = await fetch(`https://api.github.com/repos/${CONFIG.REPO_OWNER}/${CONFIG.REPO_NAME}`, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json" }
    });
    return r.ok;
  } catch (e) { return false; }
}

async function fetchMonth(monthKey) {
  // Один JSON-файл с сессиями за месяц. Если файла нет — 404, возвращаем пустой.
  const url = `https://api.github.com/repos/${CONFIG.REPO_OWNER}/${CONFIG.REPO_NAME}/contents/data/dashboard/${monthKey}.json`;
  try {
    const r = await fetch(url, {
      headers: { "Authorization": `Bearer ${state.token}`, "Accept": "application/vnd.github+json" }
    });
    if (r.status === 404) {
      return { month: monthKey, sessions: [], _sha: null };
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const meta = await r.json();
    // content приходит в base64 (с переносами)
    const decoded = atob((meta.content || "").replace(/\n/g, ""));
    const text = decodeURIComponent(escape(decoded));
    const data = JSON.parse(text);
    state.monthsSha[monthKey] = meta.sha;
    data._sha = meta.sha;
    return data;
  } catch (e) {
    console.error("fetchMonth failed:", monthKey, e);
    return null;
  }
}

async function toggleSessionIncluded(sessionId, included) {
  const monthKey = sessionId.substring(0, 7);
  // 1. Освежить данные месяца (на случай если кто-то другой уже менял)
  const data = await fetchMonth(monthKey);
  if (!data) throw new Error("не удалось прочитать файл месяца");

  // 2. Найти сессию и переключить
  const s = data.sessions.find(x => x.id === sessionId);
  if (!s) throw new Error("сессия не найдена");
  s.included = included;

  // 3. Сериализовать и обновить (PUT с sha для предотвращения гонок)
  const body = JSON.stringify({
    month: data.month,
    sessions: data.sessions
  }, null, 2);

  // base64-кодируем UTF-8
  const encoded = btoa(unescape(encodeURIComponent(body)));

  const url = `https://api.github.com/repos/${CONFIG.REPO_OWNER}/${CONFIG.REPO_NAME}/contents/data/dashboard/${monthKey}.json`;
  const r = await fetch(url, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${state.token}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: `Dashboard: ${included ? "include" : "exclude"} ${sessionId}`,
      content: encoded,
      sha: data._sha
    })
  });
  if (!r.ok) throw new Error(`PUT failed: HTTP ${r.status}`);

  // 4. Обновить локальный кэш
  state.monthsCache[monthKey] = data;
  const newMeta = await r.json();
  state.monthsSha[monthKey] = newMeta.content.sha;
  data._sha = newMeta.content.sha;
}

// ============================================================
// АГРЕГАЦИЯ / ФИЛЬТРАЦИЯ
// ============================================================
function ymd(date) {
  return date.toISOString().slice(0, 10);
}
function ym(date) {
  return date.toISOString().slice(0, 7);
}
function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function getDateRange(period, customDate) {
  const now = new Date();
  const today = startOfDay(now);
  switch (period) {
    case "today":
      return [today, new Date(today.getTime() + 86400000)];
    case "yesterday": {
      const y = new Date(today.getTime() - 86400000);
      return [y, today];
    }
    case "week": {
      const w = new Date(today.getTime() - 7 * 86400000);
      return [w, new Date(today.getTime() + 86400000)];
    }
    case "month": {
      const m = new Date(today.getFullYear(), today.getMonth(), 1);
      return [m, new Date(today.getFullYear(), today.getMonth() + 1, 1)];
    }
    case "custom": {
      const d = startOfDay(customDate);
      return [d, new Date(d.getTime() + 86400000)];
    }
  }
}

function monthsInRange(start, end) {
  // Возвращает массив "YYYY-MM" покрывающий [start, end)
  const out = [];
  const cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur < end) {
    out.push(ym(cur));
    cur.setMonth(cur.getMonth() + 1);
  }
  return out;
}

async function loadDataForRange(start, end) {
  const monthKeys = monthsInRange(start, end);
  // Параллельная подзагрузка
  await Promise.all(monthKeys.map(async mk => {
    if (!state.monthsCache[mk]) {
      const data = await fetchMonth(mk);
      if (data) state.monthsCache[mk] = data;
    }
  }));
  // Собираем сессии из кэша, фильтруем по диапазону
  const all = [];
  for (const mk of monthKeys) {
    const d = state.monthsCache[mk];
    if (!d || !d.sessions) continue;
    for (const s of d.sessions) {
      const t = new Date(s.id);
      if (t >= start && t < end) {
        s._month = mk;
        all.push(s);
      }
    }
  }
  // Сортировка: новые сверху
  all.sort((a, b) => b.id.localeCompare(a.id));
  return all;
}

function aggregate(sessions) {
  // Суммируем только included=true
  let total = 0, stock = 0, cross = 0, items = 0, orders = 0;
  const byClient = {};
  const byDay = {};

  for (const s of sessions) {
    if (s.included === false) continue;
    const t = s.totals || {};
    total += t.total || 0;
    stock += t.stock || 0;
    cross += t.cross || 0;
    items += t.items || 0;
    orders += t.orders || 0;

    // По клиентам
    for (const c of (s.clients || [])) {
      if (!byClient[c.code]) {
        byClient[c.code] = {
          code: c.code, name: c.name,
          total: 0, stock: 0, cross: 0, items: 0, orders: 0
        };
      }
      const a = byClient[c.code];
      a.total += c.total || 0;
      a.stock += c.stock || 0;
      a.cross += c.cross || 0;
      a.items += c.items || 0;
      a.orders += c.orders || 0;
    }

    // По дням
    const day = s.id.slice(0, 10);
    if (!byDay[day]) byDay[day] = { total: 0, stock: 0, cross: 0 };
    byDay[day].total += t.total || 0;
    byDay[day].stock += t.stock || 0;
    byDay[day].cross += t.cross || 0;
  }

  const clients = Object.values(byClient).sort((a, b) => b.total - a.total);
  return { total, stock, cross, items, orders, clients, byDay };
}

// ============================================================
// RENDER
// ============================================================
function formatRub(n) {
  if (n === 0) return "₽0";
  if (!isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  n = Math.abs(n);
  if (n >= 1e6) return `${sign}₽${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${sign}₽${(n / 1e3).toFixed(0)}k`;
  return `${sign}₽${Math.round(n)}`;
}
function formatRubFull(n) {
  return "₽" + Math.round(n).toLocaleString("ru-RU").replace(/,/g, " ");
}
function formatPercent(n) {
  if (!isFinite(n)) return "—";
  return (n * 100).toFixed(1) + "%";
}
function formatDateTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("ru-RU", {
      day: "2-digit", month: "2-digit",
      hour: "2-digit", minute: "2-digit"
    });
  } catch (e) { return iso; }
}

let trendChart = null, splitChart = null;

function renderKPIs(agg) {
  document.getElementById("kpiTotal").textContent = formatRubFull(agg.total);
  document.getElementById("kpiTotalSub").textContent =
    `${agg.orders} заказов · ${agg.items} позиций`;

  document.getElementById("kpiStock").textContent = formatRubFull(agg.stock);
  document.getElementById("kpiStockSub").textContent =
    agg.total ? formatPercent(agg.stock / agg.total) + " от общего" : "—";

  document.getElementById("kpiCross").textContent = formatRubFull(agg.cross);
  document.getElementById("kpiCrossSub").textContent =
    agg.total ? formatPercent(agg.cross / agg.total) + " от общего" : "—";
}

function renderClients(agg) {
  const tbody = document.getElementById("clientsTable");
  if (!agg.clients.length) {
    tbody.innerHTML = '<div class="empty">Нет данных за выбранный период</div>';
    return;
  }
  let html = `
    <table>
      <thead>
        <tr>
          <th>Клиент</th>
          <th class="num">Заказов</th>
          <th class="num">Поз.</th>
          <th class="num">Общий ТО</th>
          <th class="num">Сток</th>
          <th class="num">Кросс</th>
          <th class="num">Доля</th>
        </tr>
      </thead>
      <tbody>
  `;
  for (const c of agg.clients) {
    const share = agg.total ? (c.total / agg.total) : 0;
    html += `
      <tr>
        <td>${escapeHtml(c.name || c.code || "—")}</td>
        <td class="num">${c.orders}</td>
        <td class="num">${c.items}</td>
        <td class="num"><b>${formatRubFull(c.total)}</b></td>
        <td class="num">${formatRubFull(c.stock)}</td>
        <td class="num">${formatRubFull(c.cross)}</td>
        <td class="num">${formatPercent(share)}</td>
      </tr>
    `;
  }
  html += "</tbody></table>";
  tbody.innerHTML = html;
}

function renderSessions(sessions) {
  const list = document.getElementById("sessionsList");
  if (!sessions.length) {
    list.innerHTML = '<div class="empty">Нет сессий за выбранный период</div>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const incl = s.included !== false;
    const t = s.totals || {};
    return `
      <div class="session-row ${incl ? "included" : "excluded"}" data-id="${escapeAttr(s.id)}">
        <div class="check" title="${incl ? "Учтена (клик — исключить)" : "Исключена (клик — вернуть)"}">${incl ? "✓" : ""}</div>
        <div class="info">
          <div class="when">${formatDateTime(s.id)} · ${t.orders || 0} заказов · ${t.items || 0} поз.</div>
          <div class="who">${escapeHtml(s.operator || "—")}</div>
        </div>
        <div class="sum">
          ${formatRubFull(t.total || 0)}
          <span class="pill green" style="margin-left:8px">сток ${formatRub(t.stock || 0)}</span>
          <span class="pill orange">кросс ${formatRub(t.cross || 0)}</span>
        </div>
      </div>
    `;
  }).join("");
  // Бинд клика по чекбоксу
  list.querySelectorAll(".session-row").forEach(row => {
    row.querySelector(".check").addEventListener("click", async () => {
      const id = row.dataset.id;
      const wasIncluded = row.classList.contains("included");
      const newState = !wasIncluded;
      row.querySelector(".check").innerHTML =
        '<span style="opacity:.5">…</span>';
      try {
        await toggleSessionIncluded(id, newState);
        await refresh(true); // не перезагружаем кэш полностью
      } catch (e) {
        alert("Не удалось переключить: " + e.message);
        row.querySelector(".check").textContent = wasIncluded ? "✓" : "";
      }
    });
  });
}

// Брендовая палитра (синхронизирована с index.html :root)
const BRAND = {
  bgCard: "#0c0a3f",
  border: "#2a2480",
  borderSoft: "#1a1660",
  text: "#f0eeff",
  textDim: "#a8a5d4",
  textFaint: "#6864a0",
  accent: "#6366f1",
  green: "#34d399",
  orange: "#fbbf24",
};

function renderTrendChart(byDay) {
  const days = Object.keys(byDay).sort();
  const labels = days.map(d => d.slice(8) + "." + d.slice(5, 7));
  const ctx = document.getElementById("trendChart").getContext("2d");
  if (trendChart) trendChart.destroy();
  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Общий",
          data: days.map(d => byDay[d].total),
          borderColor: BRAND.accent,
          backgroundColor: "rgba(99,102,241,.18)",
          tension: 0.35, fill: true, borderWidth: 2,
          pointBackgroundColor: BRAND.accent, pointRadius: 3,
        },
        {
          label: "Сток",
          data: days.map(d => byDay[d].stock),
          borderColor: BRAND.green,
          backgroundColor: "rgba(52,211,153,0)",
          tension: 0.35, borderWidth: 2,
          pointBackgroundColor: BRAND.green, pointRadius: 3,
        },
        {
          label: "Кросс",
          data: days.map(d => byDay[d].cross),
          borderColor: BRAND.orange,
          backgroundColor: "rgba(251,191,36,0)",
          tension: 0.35, borderWidth: 2,
          pointBackgroundColor: BRAND.orange, pointRadius: 3,
        },
      ]
    },
    options: chartOptions("line")
  });
}

function renderSplitChart(agg) {
  const ctx = document.getElementById("splitChart").getContext("2d");
  if (splitChart) splitChart.destroy();
  splitChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: ["Сток", "Кросс"],
      datasets: [{
        data: [agg.stock, agg.cross],
        backgroundColor: [BRAND.green, BRAND.orange],
        borderColor: BRAND.bgCard, borderWidth: 3,
      }]
    },
    options: chartOptions("doughnut")
  });
}

function chartOptions(kind) {
  const base = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: { color: BRAND.textDim, font: { size: 12 } }
      },
      tooltip: {
        backgroundColor: BRAND.bgCard,
        titleColor: BRAND.text,
        bodyColor: BRAND.textDim,
        borderColor: BRAND.border, borderWidth: 1,
        callbacks: {
          label: ctx => {
            const v = ctx.parsed.y ?? ctx.parsed;
            return ` ${ctx.dataset.label || ctx.label}: ${formatRubFull(v)}`;
          }
        }
      }
    }
  };
  if (kind === "line") {
    base.scales = {
      x: {
        ticks: { color: BRAND.textFaint, font: { size: 11 } },
        grid: { color: BRAND.borderSoft }
      },
      y: {
        ticks: {
          color: BRAND.textFaint, font: { size: 11 },
          callback: v => formatRub(v)
        },
        grid: { color: BRAND.borderSoft }
      }
    };
  }
  return base;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ============================================================
// CONTROLS
// ============================================================
function setActivePeriod(period) {
  state.currentPeriod = period;
  document.querySelectorAll(".chip[data-period]").forEach(b => {
    b.classList.toggle("active", b.dataset.period === period);
  });
  if (period !== "custom") {
    document.getElementById("datePicker").value = "";
  }
  refresh();
}

document.querySelectorAll(".chip[data-period]").forEach(btn => {
  btn.addEventListener("click", () => setActivePeriod(btn.dataset.period));
});

document.getElementById("datePicker").addEventListener("change", e => {
  if (!e.target.value) return;
  state.customDate = new Date(e.target.value + "T00:00:00");
  setActivePeriod("custom");
  document.querySelectorAll(".chip[data-period]").forEach(b => b.classList.remove("active"));
});

document.getElementById("refreshBtn").addEventListener("click", () => {
  state.monthsCache = {};
  refresh();
});

// ============================================================
// MAIN REFRESH
// ============================================================
async function refresh(softCache = false) {
  if (!softCache) {
    // Полный refresh: чистим кэш чтобы получить свежие данные
    // (Auto-call после toggle оставляет кэш — там данные уже свежие)
  }
  document.getElementById("clientsTable").innerHTML =
    '<div class="loader">Загружаю...</div>';
  document.getElementById("sessionsList").innerHTML = "";

  const [start, end] = getDateRange(state.currentPeriod, state.customDate);
  const sessions = await loadDataForRange(start, end);
  const agg = aggregate(sessions);

  renderKPIs(agg);
  renderClients(agg);
  renderSessions(sessions);
  renderTrendChart(agg.byDay);
  renderSplitChart(agg);

  document.getElementById("lastUpdate").textContent =
    "Обновлено " + new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit", minute: "2-digit"
    });
}

async function showDashboard() {
  lockScreen.style.display = "none";
  dashboard.style.display = "block";
  resetLockTimer();
  // Подгружаем шапку с переключателями месяцев (последние 6)
  renderMonthsNav();
  await refresh();
}

function renderMonthsNav() {
  // Можно навигироваться по конкретным месяцам кнопками в шапке
  const nav = document.getElementById("navMonths");
  const months = [];
  const now = new Date();
  for (let i = 0; i < 4; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(d);
  }
  nav.innerHTML = months.map((d, i) => {
    const label = d.toLocaleString("ru-RU", { month: "long", year: "numeric" });
    const cap = label.charAt(0).toUpperCase() + label.slice(1);
    return `<button data-mi="${i}" ${i === 0 ? 'class="active"' : ""}>${cap}</button>`;
  }).join("");
  nav.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async () => {
      nav.querySelectorAll("button").forEach(x => x.classList.remove("active"));
      btn.classList.add("active");
      const idx = parseInt(btn.dataset.mi, 10);
      const d = months[idx];
      // Делаем кастомный период: весь месяц
      state.currentPeriod = "customMonth";
      state.customStart = new Date(d.getFullYear(), d.getMonth(), 1);
      state.customEnd = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      document.querySelectorAll(".chip[data-period]").forEach(b => b.classList.remove("active"));
      await refreshCustomMonth();
    });
  });
}

async function refreshCustomMonth() {
  document.getElementById("clientsTable").innerHTML =
    '<div class="loader">Загружаю...</div>';
  const start = state.customStart, end = state.customEnd;
  const sessions = await loadDataForRange(start, end);
  const agg = aggregate(sessions);
  renderKPIs(agg);
  renderClients(agg);
  renderSessions(sessions);
  renderTrendChart(agg.byDay);
  renderSplitChart(agg);
  document.getElementById("lastUpdate").textContent =
    "Обновлено " + new Date().toLocaleTimeString("ru-RU", {
      hour: "2-digit", minute: "2-digit"
    });
}

// ============================================================
// STARTUP
// ============================================================
// Проверка конфига
if (!CONFIG.REPO_OWNER || CONFIG.REPO_OWNER.includes("PUT_YOUR") ||
    !CONFIG.ENCRYPTED_TOKEN || CONFIG.ENCRYPTED_TOKEN.includes("PASTE")) {
  document.body.innerHTML = `
    <div style="padding:40px;max-width:600px;margin:40px auto;
                font-family:sans-serif;background:#1e293b;color:#fbbf24;
                border-radius:12px;border:1px solid #92400e;line-height:1.6">
      <h2 style="margin-top:0">⚙️ Не настроен config.js</h2>
      <p>Открой <code>config.js</code> и заполни:</p>
      <ul>
        <li><code>REPO_OWNER</code> — твой GitHub-логин</li>
        <li><code>ENCRYPTED_TOKEN</code> — blob из encrypt.html</li>
      </ul>
    </div>
  `;
}

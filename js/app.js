import { createBackend, AdminError } from './backend.js';
import {
  SUGAR_OPTIONS, ICE_OPTIONS, esc, formatPrice, aggregate, totalOf, expectedPeople, groupByUnit, pendingPeople,
  drinkLabel, summaryText, detailText, favsFor, sheetHTML, parseMenu, parseToppingsText, mergeToppings, applyMenu,
  parseRoster, mergeRoster, readTextFile, menuToCSV, splitMenuSections, rosterToCSV,
} from './logic.js';

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const WHO_KEY = 'drink-who';
const PW_KEY = 'drink-admin-pw';
const MANUAL = '_manual';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* 私密瀏覽 */ } },
};
function loadWho() {
  try { const v = JSON.parse(store.get(WHO_KEY)); if (v && typeof v.unit === 'string' && typeof v.name === 'string') return v; } catch { /* ignore */ }
  return { unit: '', name: '' };
}
const newForm = () => ({ item: '', size: '', sugar: '正常糖', ice: '正常冰', tops: [], note: '', qty: 1, editId: null, q: '' });
const defaultTitle = () => { const d = new Date(); return `${d.getMonth() + 1}/${d.getDate()} 飲料團`; };

const S = {
  backend: null,
  data: null,
  error: null,
  live: 'connecting',
  tab: 'order',
  sid: params.get('g'),
  pw: DEMO ? null : store.get(PW_KEY),
  who: loadWho(),
  f: newForm(),
  favQty: 1,
  modal: null,
  armed: null,
  busy: false,
  menu: { selId: null, draft: null, dirty: false, newName: '', newPhone: '', filter: '', topPaste: '' },
  roster: { draft: null, dirty: false, newUnit: '', add: {} },
};

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal');

// ---------------------------------------------------------------- 小工具

function toast(msg, kind = 'ok') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return toast('複製失敗，請手動選取', 'err');
  }
  toast(okMsg);
}

let seq = 0;
const nk = () => `n${++seq}`;

const sessions = () => S.data?.sessions ?? [];
function current() {
  const list = sessions();
  return list.find((s) => s.id === S.sid) ?? list.find((s) => s.status === 'open') ?? list[0];
}
const shopOf = (session) => S.data?.shops.find((s) => s.id === session?.shop_id);
const sessionOrders = (session) => (S.data?.orders ?? []).filter((o) => o.session_id === session?.id);
const allPeople = (units) => units.flatMap((u) => u.members.map((name) => ({ unit: u.name, name })));

function syncUrl() {
  const cur = current();
  const q = new URLSearchParams(location.search);
  if (cur) q.set('g', cur.id); else q.delete('g');
  const qs = q.toString().replace(/demo=(&|$)/, 'demo$1');
  const url = `${location.pathname}${qs ? `?${qs}` : ''}`;
  if (url !== `${location.pathname}${location.search}`) history.replaceState(null, '', url);
}

// 錯誤處理：管理密碼失效時登出並重新顯示登入視窗
async function run(fn, okMsg) {
  if (S.busy) return false;
  S.busy = true;
  render();
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await refresh();
    return r ?? true;
  } catch (e) {
    if (e instanceof AdminError && /錯誤$/.test(e.message)) {
      setPw(null);
      S.modal = { type: 'gate', pw: '' };
    }
    toast(e.message || '發生錯誤', 'err');
    return false;
  } finally {
    S.busy = false;
    render();
  }
}

function setPw(pw) {
  S.pw = pw;
  if (!DEMO) store.set(PW_KEY, pw);
}

// ---------------------------------------------------------------- 資料載入與即時同步

let refreshing = null;
let again = false;
async function refresh() {
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    try {
      do {
        again = false;
        S.data = await S.backend.load();
        S.error = null;
        reconcile();
      } while (again);
    } catch (e) {
      S.error = e.message;
    } finally {
      refreshing = null;
    }
    render();
  })();
  return refreshing;
}

function reconcile() {
  const { shops, units } = S.data;
  const m = S.menu;
  if (!m.selId || !shops.some((s) => s.id === m.selId)) {
    m.selId = shops[0]?.id ?? null;
    m.dirty = false;
  }
  if (!m.dirty) m.draft = toDraft(shops.find((s) => s.id === m.selId));
  if (!S.roster.dirty) S.roster.draft = units.map((u) => ({ key: u.id, id: u.id, name: u.name, members: [...u.members] }));
  if (S.f.editId && !S.data.orders.some((o) => o.id === S.f.editId)) S.f.editId = null;
  syncUrl();
}

const toDraft = (s) => s && {
  name: s.name, phone: s.phone, sizes: [...s.sizes],
  items: s.items.map((i) => ({ key: nk(), n: i.n, p: [...i.p] })),
  toppings: s.toppings.map((t) => ({ key: nk(), ...t })),
};

let refreshTimer = null;
const scheduleRefresh = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 150); };

let pollTimer = null;
function setLive(status) {
  S.live = status === 'SUBSCRIBED' ? 'live' : status === 'connecting' ? 'connecting' : 'offline';
  if (status === 'SUBSCRIBED') refresh(); // 重新連線後補抓斷線期間的變動
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, S.live === 'live' ? 60000 : 15000);
  render();
}

// ---------------------------------------------------------------- 畫面

let composing = false;
let pendingRender = false;

function render() {
  if (composing) { pendingRender = true; return; }
  pendingRender = false;
  const a = document.activeElement;
  const key = a?.dataset?.k;
  let sel = null;
  try { sel = key && a.selectionStart != null ? [a.selectionStart, a.selectionEnd] : null; } catch { /* number 欄位 */ }
  const scrolls = {};
  document.querySelectorAll('[data-scroll]').forEach((el) => { scrolls[el.dataset.scroll] = el.scrollTop; });

  app.innerHTML = viewApp();
  modalRoot.innerHTML = S.modal ? viewModal() : '';
  document.body.classList.toggle('modal-open', !!S.modal);

  document.querySelectorAll('[data-scroll]').forEach((el) => { if (scrolls[el.dataset.scroll]) el.scrollTop = scrolls[el.dataset.scroll]; });
  if (key) {
    const el = document.querySelector(`[data-k="${CSS.escape(key)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch { /* ignore */ }
    }
  } else if (S.modal) {
    const auto = modalRoot.querySelector('[autofocus]');
    if (auto && !modalRoot.contains(a)) auto.focus();
  }
}

const btn = (act, label, { cls = '', attrs = '', disabled = false } = {}) =>
  `<button type="button" class="btn ${cls}" data-act="${act}" ${attrs} ${disabled ? 'disabled' : ''}>${label}</button>`;

function confirmBtn(key, label, confirmLabel, attrs = '', cls = 'danger') {
  const armed = S.armed === key;
  return `<button type="button" class="btn ${armed ? 'danger-solid' : cls} sm" data-act="confirm" data-key="${esc(key)}" ${attrs}>${esc(armed ? confirmLabel : label)}</button>`;
}

const chips = (bind, options, value, disabled = []) =>
  `<div class="chips">${options.map((o) => `<button type="button" class="chip ${o === value ? 'on' : ''}" data-act="pick" data-bind="${bind}" data-v="${esc(o)}" ${disabled.includes(o) ? 'disabled' : ''} aria-pressed="${o === value}">${esc(o)}</button>`).join('')}</div>`;

function viewApp() {
  const liveDot = DEMO ? '<span class="live demo">示範模式</span>'
    : `<span class="live ${S.live}">${S.live === 'live' ? '即時同步' : S.live === 'connecting' ? '連線中…' : '離線・自動重試'}</span>`;
  const head = `<header class="top">
    <div class="brand"><span class="logo" aria-hidden="true">🧋</span><h1>辦公室飲料訂購</h1></div>
    <div class="top-r">${liveDot}${S.pw
      ? btn('logout', '🔓 管理者（登出）', { cls: 'ghost sm' })
      : btn('gate', '🔒 管理者', { cls: 'ghost sm' })}</div>
  </header>`;
  if (!S.data) {
    return head + (S.error ? `<p class="err">讀取失敗：${esc(S.error)} ${btn('reload', '重試', { cls: 'sm' })}</p>` : '<div class="skeleton"></div>');
  }
  const cur = current();
  const tabs = [['order', '訂購'], ['summary', '彙總'], ['menu', '菜單'], ['roster', '名單']];
  let pane;
  if (S.tab === 'order') pane = cur ? viewOrder(cur) : '<p class="empty">還沒有任何團。按上方「開新團」開始吧！</p>';
  else if (S.tab === 'summary') pane = cur ? viewSummary(cur) : '<p class="empty">還沒有任何團。</p>';
  else if (!S.pw) pane = `<div class="lock"><div class="big">🔒</div><p>這個頁面需要管理者密碼。</p>${btn('gate', '管理者登入', { cls: 'primary' })}</div>`;
  else pane = S.tab === 'menu' ? viewMenu() : viewRoster();
  return `${head}
    ${S.error ? `<p class="err">更新失敗：${esc(S.error)}</p>` : ''}
    ${viewSessionBar(cur)}
    <nav class="tabs" role="tablist">${tabs.map(([k, l]) => `<button type="button" role="tab" class="tab ${S.tab === k ? 'on' : ''}" aria-selected="${S.tab === k}" data-act="tab" data-v="${k}">${l}</button>`).join('')}</nav>
    <main class="pane">${pane}</main>
    ${DEMO ? `<p class="foot">示範模式：資料只存在這個分頁，重新整理就會還原。管理密碼 <code>${esc(S.backend.demoPassword)}</code></p>` : ''}`;
}

function viewSessionBar(cur) {
  const list = sessions();
  const opts = list.map((s) => `<option value="${esc(s.id)}" ${s.id === cur?.id ? 'selected' : ''}>${esc(s.title)}・${esc(s.shop_name)}${s.status === 'closed' ? '（已結束）' : ''}</option>`).join('');
  return `<section class="bar">
    <div class="bar-pick">
      <select data-change="session" aria-label="選擇團" ${list.length ? '' : 'disabled'}>${list.length ? opts : '<option>還沒有任何團</option>'}</select>
      ${btn('newSession', '＋ 開新團', { cls: 'primary' })}
    </div>
    ${cur ? `<div class="bar-actions">
      <span class="badge ${cur.status === 'open' ? 'ok' : ''}">${cur.status === 'open' ? '訂購中' : '已結束'}</span>
      ${btn('share', '🔗 複製分享連結', { cls: 'sm' })}
      ${btn('editParticipants', `👥 參加成員${cur.participants ? `（${cur.participants.length} 人）` : '（全部）'}`, { cls: 'sm' })}
      ${cur.status === 'open' ? btn('close', '結束訂購', { cls: 'sm', disabled: S.busy }) : btn('reopen', '重新開放', { cls: 'sm', disabled: S.busy })}
    </div>` : ''}
  </section>`;
}

function viewPending(groups, pickable) {
  const total = groups.reduce((s, g) => s + g.names.length, 0);
  if (total === 0) return '<section class="card pending done"><b>全員都訂好了 🎉</b></section>';
  return `<section class="card pending"><h3>⏳ 還沒選購（${total} 人）</h3>
    ${groups.map((g) => `<div class="prow"><span class="punit">${esc(g.unit)}</span><span class="pnames">${g.names.map((n) => pickable
      ? `<button type="button" class="pname" data-act="pickPerson" data-unit="${esc(g.unit)}" data-name="${esc(n)}">${esc(n)}</button>`
      : `<span class="pname static">${esc(n)}</span>`).join('')}</span></div>`).join('')}
    ${pickable ? '<p class="hint">點名字可以直接幫那個人點。</p>' : ''}
  </section>`;
}

function viewOrder(session) {
  const shop = shopOf(session);
  if (!shop) return '<p class="empty">這個團的飲料店已被刪除，請重新開一團。</p>';
  const { units, orders: all } = S.data;
  const open = session.status === 'open';
  const restricted = !!session.participants;
  const f = S.f;
  const expected = expectedPeople(session, units);
  const selectable = units.filter((u) => expected.some((p) => p.unit === u.name));
  const unitObj = selectable.find((u) => u.name === S.who.unit);
  const members = unitObj ? expected.filter((p) => p.unit === unitObj.name).map((p) => p.name) : [];
  const orders = sessionOrders(session);
  const name = S.who.name.trim();
  const mine = name ? orders.filter((o) => o.name === name) : [];
  const favs = favsFor(name, all, shop);

  const itemObj = shop.items.find((i) => i.n === f.item);
  const sizeIdx = shop.sizes.indexOf(f.size);
  const base = itemObj && sizeIdx >= 0 ? itemObj.p[sizeIdx] : null;
  const chosenTops = shop.toppings.filter((t) => f.tops.includes(t.n));
  const price = base != null ? base + chosenTops.reduce((s, t) => s + t.p, 0) : null;
  const missing = itemObj ? shop.sizes.filter((_, i) => itemObj.p[i] == null) : [];
  const q = f.q.trim().toLowerCase();
  const filtered = q ? shop.items.filter((i) => i.n.toLowerCase().includes(q)) : shop.items;
  const tel = shop.phone ? `・<a href="tel:${esc(shop.phone.split(/[；;、,]/)[0].replace(/[^\d+#*]/g, ''))}">${esc(shop.phone)}</a>` : '';

  return `
    ${open ? '' : '<div class="closed">這個團已結束訂購，只能查看。需要加點請按上方「重新開放」。</div>'}
    ${expected.length ? viewPending(pendingPeople(orders, units, session), open) : ''}

    <section class="card">
      <h3>1. 你是誰？</h3>
      <div class="who">
        <select data-change="whoUnit" aria-label="選擇單位">
          <option value="" disabled ${!unitObj && S.who.unit !== MANUAL ? 'selected' : ''}>選擇單位</option>
          ${selectable.map((u) => `<option value="${esc(u.name)}" ${unitObj?.name === u.name ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
          <option value="${MANUAL}" ${!unitObj && S.who.unit === MANUAL ? 'selected' : ''}>${restricted ? '不在名單上（手動輸入姓名）' : '其他（手動輸入姓名）'}</option>
        </select>
        ${unitObj
          ? `<select data-change="whoName" aria-label="選擇姓名">
              <option value="" disabled ${members.includes(name) ? '' : 'selected'}>選擇姓名</option>
              ${members.map((m) => `<option value="${esc(m)}" ${m === name ? 'selected' : ''}>${esc(m)}${orders.some((o) => o.name === m) ? '（已訂）' : ''}</option>`).join('')}
            </select>`
          : `<input type="text" data-k="whoName" data-bind="who.name" data-rerender maxlength="40" placeholder="輸入你的姓名" value="${esc(S.who.name)}">`}
      </div>
    </section>

    ${favs.length && open ? `<section class="card">
      <h3 class="row-h">常點的（一鍵再訂）${stepper('favQty', S.favQty, '再訂杯數')}</h3>
      <ul class="favs">${favs.map((x, i) => `<li>
        <button type="button" class="fav-text" data-act="loadFav" data-i="${i}" title="帶入下方表單修改">
          <span class="fav-name">${esc(drinkLabel(x))}</span><span class="fav-meta">$${x.price}・點過 ${x.count} 次</span>
        </button>
        ${btn('reorder', `↻ 再訂${S.favQty > 1 ? ` ${S.favQty} 杯` : '一杯'}`, { cls: 'primary sm', attrs: `data-i="${i}"`, disabled: S.busy })}
      </li>`).join('')}</ul>
    </section>` : ''}

    <section class="card" id="drink">
      <h3 class="row-h">2. 選飲料${f.editId ? '（修改中）' : ''}<span class="shop">${esc(session.shop_name)}${tel}</span></h3>
      <input type="search" class="search" data-k="q" data-bind="f.q" data-rerender placeholder="🔍 搜尋品名" value="${esc(f.q)}">
      <ul class="menu" data-scroll="menu">
        ${filtered.map((i) => `<li><button type="button" class="menu-item ${f.item === i.n ? 'on' : ''}" data-act="pickItem" data-v="${esc(i.n)}">
          <span>${esc(i.n)}</span>
          <span class="prices">${shop.sizes.map((s, k) => (i.p[k] != null ? `${esc(s)} $${i.p[k]}` : null)).filter(Boolean).join(' / ')}</span>
        </button></li>`).join('')}
        ${filtered.length ? '' : '<li class="empty">找不到符合的飲料</li>'}
      </ul>
      ${f.item ? `<div class="opts">
        <div class="picked">已選：${esc(f.item)}</div>
        <label class="lbl">規格</label>${chips('f.size', shop.sizes, f.size, missing)}
        <label class="lbl">甜度</label>${chips('f.sugar', SUGAR_OPTIONS, f.sugar)}
        <label class="lbl">冰量</label>${chips('f.ice', ICE_OPTIONS, f.ice)}
        ${shop.toppings.length ? `<label class="lbl">加料（可多選）</label><div class="chips">${shop.toppings.map((t) => {
          const on = f.tops.includes(t.n);
          return `<button type="button" class="chip ${on ? 'on' : ''}" data-act="toggleTop" data-v="${esc(t.n)}" aria-pressed="${on}">${esc(t.n)}${t.p > 0 ? ` +$${t.p}` : ''}</button>`;
        }).join('')}</div>` : ''}
        <label class="lbl">備註（選填）</label>
        <input type="text" data-k="note" data-bind="f.note" maxlength="100" placeholder="例如：不要吸管" value="${esc(f.note)}">
        <div class="submit-row">
          <div class="price">${price != null ? `$${price * (f.editId ? 1 : f.qty)}` : '—'}${!f.editId && f.qty > 1 && price != null ? `<small> $${price} × ${f.qty}</small>` : ''}</div>
          ${f.editId ? btn('cancelEdit', '取消修改') : stepper('f.qty', f.qty, '杯數')}
          ${btn('submitOrder', f.editId ? '儲存修改' : f.qty > 1 ? `加入 ${f.qty} 杯` : '加入訂單', { cls: 'primary lg', disabled: !open || S.busy })}
        </div>
      </div>` : ''}
    </section>

    ${name ? `<section class="card">
      <h3>${esc(name)} 在這團的訂單（${mine.length} 杯）</h3>
      ${mine.length ? `<ul class="list">${mine.map((o) => `<li>
        <span class="grow">${esc(drinkLabel(o))} <b class="money">${o.price != null ? `$${o.price}` : ''}</b></span>
        ${open ? `${btn('editOrder', '✏️', { cls: 'icon', attrs: `data-id="${esc(o.id)}" aria-label="修改"` })}${btn('delOrder', '🗑️', { cls: 'icon', attrs: `data-id="${esc(o.id)}" aria-label="刪除"`, disabled: S.busy })}` : ''}
      </li>`).join('')}</ul>` : '<p class="empty">還沒有訂單</p>'}
    </section>` : ''}`;
}

const stepper = (bind, value, label) => `<span class="stepper" aria-label="${esc(label)}">
  <button type="button" class="step" data-act="step" data-bind="${bind}" data-d="-1" ${value <= 1 ? 'disabled' : ''} aria-label="減少">−</button>
  <span class="step-v">${value}</span>
  <button type="button" class="step" data-act="step" data-bind="${bind}" data-d="1" ${value >= 30 ? 'disabled' : ''} aria-label="增加">＋</button>
</span>`;

function viewSummary(session) {
  const { units } = S.data;
  const orders = sessionOrders(session);
  const pending = pendingPeople(orders, units, session);
  const open = session.status === 'open';
  if (!orders.length) return `<p class="empty">這團還沒有人訂飲料。</p>${pending.length ? viewPending(pending, false) : ''}`;
  const agg = aggregate(orders);
  const groups = groupByUnit(orders, units, session).filter((g) => g.orders.length > 0);
  return `<section class="card">
      <div class="row-h"><h3>品項彙總</h3><div class="total">${orders.length} 杯・$${totalOf(orders)}</div></div>
      <ul class="list">${agg.map((r) => `<li><span class="grow">${esc(drinkLabel(r))}</span><span class="cnt">× ${r.count}</span><span class="money">$${r.total}</span></li>`).join('')}</ul>
      <div class="btns">
        ${btn('copySummary', '📋 複製彙總（給店家）', { cls: 'sm' })}
        ${btn('copyDetail', '📋 複製明細（Excel）', { cls: 'sm' })}
        ${btn('printSheet', '🖨️ 列印分發單', { cls: 'primary sm' })}
        ${btn('downloadSheet', '⬇️ 下載分發單', { cls: 'sm' })}
      </div>
    </section>
    ${pending.length ? viewPending(pending, false) : ''}
    ${groups.map((g) => `<section class="card">
      <div class="row-h"><h3>${esc(g.unit)}</h3><div class="sub">${g.orders.length} 杯・$${totalOf(g.orders)}</div></div>
      <ul class="list">${g.orders.map((o) => `<li>
        <span class="who-n">${esc(o.name)}</span><span class="grow">${esc(drinkLabel(o))}</span><span class="money">${o.price != null ? `$${o.price}` : ''}</span>
        ${open ? btn('delOrder', '🗑️', { cls: 'icon', attrs: `data-id="${esc(o.id)}" aria-label="刪除"`, disabled: S.busy }) : ''}
      </li>`).join('')}</ul>
    </section>`).join('')}`;
}

function viewMenu() {
  const { shops } = S.data;
  const m = S.menu;
  const d = m.draft;
  const k = m.filter.trim().toLowerCase();
  const visible = d ? d.items.map((it, idx) => ({ it, idx })).filter(({ it }) => !k || it.n.toLowerCase().includes(k)) : [];
  return `<section class="card">
      <h3>飲料店</h3>
      ${shops.length ? `<select data-change="menuShop" aria-label="選擇店家">${shops.map((s) => `<option value="${esc(s.id)}" ${s.id === m.selId ? 'selected' : ''}>${esc(s.name)}${s.phone ? `・${esc(s.phone)}` : ''}（${s.items.length} 品項）</option>`).join('')}</select>` : ''}
      <div class="stack">
        <input type="text" data-k="newShopName" data-bind="menu.newName" data-rerender maxlength="60" placeholder="新增店家名稱，例如：五十嵐" value="${esc(m.newName)}">
        <div class="add-row">
          <input type="tel" inputmode="tel" data-k="newShopPhone" data-bind="menu.newPhone" data-enter="addShop" maxlength="30" placeholder="店家電話（選填）" value="${esc(m.newPhone)}">
          ${btn('addShop', '＋ 新增', { cls: 'primary', disabled: !m.newName.trim() || S.busy })}
        </div>
      </div>
    </section>
    ${d ? `<section class="card">
      <h3>店家設定</h3>
      <label class="lbl">店名</label>
      <input type="text" data-k="dName" data-bind="menu.draft.name" data-dirty="menu" maxlength="60" value="${esc(d.name)}">
      <label class="lbl">店家電話</label>
      <input type="tel" inputmode="tel" data-k="dPhone" data-bind="menu.draft.phone" data-dirty="menu" maxlength="30" placeholder="例如：04-2635-1234" value="${esc(d.phone)}">
      <label class="lbl">規格欄位（例如 中杯、大杯）</label>
      <div class="sizes">
        ${d.sizes.map((s, i) => `<div class="size-box"><input type="text" data-k="size${i}" data-bind="menu.draft.sizes.${i}" data-dirty="menu" data-rerender maxlength="20" value="${esc(s)}">
          ${d.sizes.length > 1 ? btn('delSize', '✕', { cls: 'icon', attrs: `data-i="${i}" aria-label="刪除規格"` }) : ''}</div>`).join('')}
        ${d.sizes.length < 8 ? btn('addSize', '＋ 新增規格', { cls: 'sm' }) : ''}
      </div>
    </section>
    <section class="card">
      <div class="row-h"><h3>品項與價格（${d.items.length}）</h3>
        <div class="btns">${btn('importMenu', '⬆️ 匯入菜單', { cls: 'sm' })}${btn('exportMenu', '⬇️ 匯出菜單', { cls: 'sm', disabled: !d.items.length && !d.toppings.length })}${btn('addItem', '＋ 新增品項', { cls: 'sm' })}</div></div>
      ${d.items.length > 8 ? `<input type="search" class="search" data-k="menuFilter" data-bind="menu.filter" data-rerender placeholder="🔍 搜尋品項" value="${esc(m.filter)}">` : ''}
      ${d.items.length ? '' : '<p class="empty">還沒有品項，按「匯入菜單」或「新增品項」。</p>'}
      <ul class="items">${visible.map(({ it, idx }) => `<li class="item">
        <div class="item-top"><input type="text" data-k="in-${it.key}" data-bind="menu.draft.items.${idx}.n" data-dirty="menu" maxlength="100" placeholder="品名" value="${esc(it.n)}">
          ${btn('delItem', '🗑️', { cls: 'icon', attrs: `data-i="${idx}" aria-label="刪除品項"` })}</div>
        <div class="item-prices">${d.sizes.map((s, si) => `<label class="pcell"><span>${esc(s)}</span>
          <input type="text" inputmode="numeric" data-k="ip-${it.key}-${si}" data-price="${idx}:${si}" placeholder="—" value="${it.p[si] ?? ''}"></label>`).join('')}</div>
      </li>`).join('')}</ul>
    </section>
    <section class="card">
      <div class="row-h"><h3>加料（${d.toppings.length}）</h3>${btn('addTop', '＋ 新增加料', { cls: 'sm' })}</div>
      <p class="hint">同事點餐時可多選；加價會自動算進杯價。沒有加價就填 0。</p>
      <ul class="items">${d.toppings.map((t, i) => `<li class="item"><div class="item-top">
        <input type="text" data-k="tn-${t.key}" data-bind="menu.draft.toppings.${i}.n" data-dirty="menu" maxlength="40" placeholder="加料名稱，例如：大珍珠" value="${esc(t.n)}">
        <input type="text" class="top-price" inputmode="numeric" data-k="tp-${t.key}" data-tprice="${i}" placeholder="加價" value="${t.p}">
        ${btn('delTop', '🗑️', { cls: 'icon', attrs: `data-i="${i}" aria-label="刪除加料"` })}
      </div></li>`).join('')}</ul>
      <label class="lbl">一次貼上多個加料（每行一個：名稱 加價）</label>
      <textarea rows="3" data-k="topPaste" data-bind="menu.topPaste" data-rerender placeholder="大珍珠 10&#10;小珍珠 10&#10;椰果 10">${esc(m.topPaste)}</textarea>
      <div>${btn('pasteTops', '加入這些加料', { cls: 'sm', disabled: !m.topPaste.trim() })}</div>
    </section>
    <div class="save-bar">
      ${confirmBtn(`delShop:${m.selId}`, '刪除這家店', '再按一次刪除這家店')}
      ${btn('saveShop', `💾 ${m.dirty ? '儲存菜單' : '已儲存'}`, { cls: 'primary lg', disabled: !m.dirty || S.busy })}
    </div>` : ''}`;
}

function viewRoster() {
  const r = S.roster;
  const draft = r.draft ?? [];
  const people = draft.reduce((s, u) => s + u.members.length, 0);
  return `<section class="card">
      <div class="row-h"><h3>單位與姓名（${draft.length} 單位・${people} 人）</h3><div class="btns">${btn('importRoster', '⬆️ 批次匯入', { cls: 'sm' })}${btn('exportRoster', '⬇️ 匯出名單', { cls: 'sm', disabled: !draft.length })}</div></div>
      <div class="add-row">
        <input type="text" data-k="newUnit" data-bind="roster.newUnit" data-rerender data-enter="addUnit" maxlength="60" placeholder="新增單位名稱" value="${esc(r.newUnit)}">
        ${btn('addUnit', '＋ 新增', { cls: 'primary', disabled: !r.newUnit.trim() })}
      </div>
    </section>
    ${draft.map((u, i) => `<section class="card">
      <div class="unit-head">
        <input type="text" class="unit-name" data-k="un-${u.key}" data-bind="roster.draft.${i}.name" data-dirty="roster" maxlength="60" value="${esc(u.name)}">
        ${confirmBtn(`delUnit:${u.key}`, '刪除單位', '確認刪除單位')}
      </div>
      <div class="members">${u.members.map((m) => `<span class="member">${esc(m)}<button type="button" class="x" data-act="removeMember" data-key="${esc(u.key)}" data-v="${esc(m)}" aria-label="移除 ${esc(m)}">✕</button></span>`).join('') || '<span class="none">還沒有人員</span>'}</div>
      <div class="add-row">
        <input type="text" data-k="ua-${u.key}" data-bind="roster.add.${u.key}" data-rerender data-enter="addMembers" data-key="${esc(u.key)}" placeholder="新增姓名（可一次輸入多位，用逗號或空白分隔）" value="${esc(r.add[u.key] ?? '')}">
        ${btn('addMembers', '加入', { attrs: `data-key="${esc(u.key)}"`, disabled: !(r.add[u.key] ?? '').trim() })}
      </div>
    </section>`).join('')}
    <div class="save-bar">
      <span class="hint">${r.dirty ? '有尚未儲存的修改' : '名單已是最新'}</span>
      ${btn('saveRoster', '💾 儲存名單', { cls: 'primary lg', disabled: !r.dirty || S.busy })}
    </div>`;
}

// ---------------------------------------------------------------- 對話框

function viewPicker(picked) {
  const units = S.data.units;
  const all = allPeople(units);
  if (!all.length) return '<p class="hint">名單裡還沒有人員，請管理者先到「名單」分頁新增。</p>';
  const on = new Set(picked.map((p) => `${p.unit}\u0000${p.name}`));
  return `<div class="picker">
    <div class="picker-top"><span>已選 ${picked.length} / ${all.length} 人</span>${btn('pickAll', '全選', { cls: 'sm' })}${btn('pickNone', '全不選', { cls: 'sm' })}</div>
    <div class="picker-scroll" data-scroll="picker">${units.filter((u) => u.members.length).map((u) => {
      const n = u.members.filter((m) => on.has(`${u.name}\u0000${m}`)).length;
      return `<div class="picker-unit"><div class="picker-head"><b>${esc(u.name)}</b><span class="sub">${n}/${u.members.length}</span>
        <button type="button" class="link" data-act="pickUnit" data-unit="${esc(u.name)}" data-on="${n < u.members.length ? 1 : 0}">${n < u.members.length ? '全選' : '全不選'}</button></div>
        <div class="chips">${u.members.map((m) => {
          const sel = on.has(`${u.name}\u0000${m}`);
          return `<button type="button" class="chip ${sel ? 'on' : ''}" aria-pressed="${sel}" data-act="pickOne" data-unit="${esc(u.name)}" data-name="${esc(m)}">${esc(m)}</button>`;
        }).join('')}</div></div>`;
    }).join('')}</div>
  </div>`;
}

function viewModal() {
  const md = S.modal;
  const shell = (title, desc, body, foot) => `<div class="overlay" data-act="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}">
    <div class="dlg-head"><h2>${esc(title)}</h2>${btn('closeModal', '✕', { cls: 'icon', attrs: 'aria-label="關閉"' })}</div>
    ${desc ? `<p class="hint">${desc}</p>` : ''}<div class="dlg-body">${body}</div><div class="dlg-foot">${foot}</div></div></div>`;

  if (md.type === 'gate') {
    return shell('管理者登入', '輸入管理密碼後，才能修改飲料店菜單與單位姓名名單。',
      `<input type="password" autofocus data-k="gatePw" data-bind="modal.pw" data-rerender data-enter="unlock" placeholder="管理密碼" autocomplete="current-password" value="${esc(md.pw)}">`,
      btn('unlock', S.busy ? '確認中…' : '解鎖', { cls: 'primary', disabled: !md.pw || S.busy }));
  }
  if (md.type === 'newSession') {
    const shops = S.data.shops;
    return shell('開新團', '選一家飲料店和這次參加的人，同事就能用連結點餐。',
      `<label class="lbl">團名</label><input type="text" data-k="nsTitle" data-bind="modal.title" maxlength="60" value="${esc(md.title)}">
      <label class="lbl">飲料店</label>
      ${shops.length ? `<select data-change="nsShop">${shops.map((s) => `<option value="${esc(s.id)}" ${s.id === md.shopId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`
        : '<p class="hint">還沒有飲料店，請管理者先到「菜單」分頁新增店家。</p>'}
      <label class="lbl">這次要訂的人</label>
      ${chips('modal.who', ['名單上所有人', '指定這次的成員'], md.who)}
      ${md.who === '指定這次的成員' ? viewPicker(md.picked) : ''}
      <p class="hint">開團後，「訂購」和「彙總」會顯示這些人誰還沒選購飲料。</p>`,
      btn('createSession', '開團', { cls: 'primary', disabled: S.busy || !shops.length }));
  }
  if (md.type === 'participants') {
    return shell('調整參加成員', '勾選這個團要訂的人。已經訂的人不會因為取消勾選而被刪除訂單。', viewPicker(md.picked),
      btn('participantsAll', '改回「名單上所有人」', { disabled: S.busy }) + btn('participantsSave', '儲存成員', { cls: 'primary', disabled: S.busy }));
  }
  if (md.type === 'importMenu') {
    const p = parsedMenu(md);
    return shell('匯入菜單', '貼上文字或 Excel 儲存格（每行：品名、各規格價格），或上傳 CSV。第一行若是「品名、中杯、大杯」會當作規格名稱；用「匯出菜單」下載的檔案可以直接匯入（含加料）。',
      `<div>${btn('pickFile', '📄 上傳 CSV / 文字檔', { cls: 'sm', attrs: 'data-target="menuFile"' })}<input type="file" id="menuFile" hidden accept=".csv,.txt,.tsv,text/csv,text/plain" data-change="menuFile"></div>
      <label class="lbl">飲料與價格</label>
      <textarea rows="8" data-k="imText" data-bind="modal.text" data-rerender placeholder="品名,中杯,大杯&#10;珍珠奶茶,50,60&#10;四季春茶,30,35">${esc(md.text)}</textarea>
      <label class="lbl">加料（每行一個：名稱 加價，沒寫價格視為免費）</label>
      <textarea rows="4" data-k="imTops" data-bind="modal.topText" data-rerender placeholder="大珍珠 10&#10;小珍珠 10&#10;椰果 10">${esc(md.topText)}</textarea>
      ${p ? `<div class="preview">讀到 <b>${p.items.length}</b> 個品項、<b>${p.toppings.length}</b> 種加料；規格：${esc(p.sizes.join('、'))}
        ${p.items.slice(0, 3).map((i) => `<div class="pv">${esc(i.n)} — ${i.p.map((x) => formatPrice(x)).join(' / ')}</div>`).join('')}</div>` : ''}
      ${chips('modal.mode', ['加入到現有菜單', '取代整份菜單'], md.mode)}`,
      btn('applyMenu', '套用到草稿', { cls: 'primary', disabled: !p }));
  }
  if (md.type === 'importRoster') {
    const parsed = md.text.trim() ? parseRoster(md.text) : [];
    const people = parsed.reduce((s, u) => s + u.members.length, 0);
    return shell('匯入單位與姓名', '每行一個單位：「單位,姓名1,姓名2…」或「單位：姓名1、姓名2」。可從 Excel 直接貼上，或上傳 CSV（支援 Big5）。',
      `<div>${btn('pickFile', '📄 上傳 CSV / 文字檔', { cls: 'sm', attrs: 'data-target="rosterFile"' })}<input type="file" id="rosterFile" hidden accept=".csv,.txt,.tsv,text/csv,text/plain" data-change="rosterFile"></div>
      <textarea rows="9" data-k="irText" data-bind="modal.text" data-rerender placeholder="公用組,王小明,李大華&#10;運轉組：陳一、林二、張三">${esc(md.text)}</textarea>
      ${parsed.length ? `<div class="preview">讀到 <b>${parsed.length}</b> 個單位、<b>${people}</b> 位人員</div>` : ''}
      ${chips('modal.mode', ['合併到現有名單', '取代整份名單'], md.mode)}`,
      btn('applyRoster', '套用到草稿', { cls: 'primary', disabled: !parsed.length }));
  }
  return '';
}

function parsedMenu(md) {
  // 匯出的 CSV 下方有「加料」區段，跟加料欄位的內容合併
  const sec = splitMenuSections(md.text);
  const m = sec.menu.trim() ? parseMenu(sec.menu) : { sizes: ['中杯'], items: [] };
  const topText = [sec.toppings, md.topText].filter((s) => s.trim()).join('\n');
  const toppings = topText.trim() ? parseToppingsText(topText) : [];
  if (!m.items.length && !toppings.length) return null;
  return { ...m, toppings };
}

// ---------------------------------------------------------------- 狀態路徑

function setPath(path, value) {
  const parts = path.split('.');
  let o = S;
  for (let i = 0; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts.at(-1)] = value;
}
function getPath(path) {
  return path.split('.').reduce((o, k) => o?.[k], S);
}

function editMenu(fn) {
  fn(S.menu.draft);
  S.menu.dirty = true;
  render();
}
function editRoster(fn) {
  fn(S.roster.draft);
  S.roster.dirty = true;
  render();
}

// ---------------------------------------------------------------- 操作

function orderFields(o) {
  const cur = current();
  const expected = expectedPeople(cur, S.data.units);
  const isRosterUnit = S.data.units.some((u) => u.name === S.who.unit && expected.some((p) => p.unit === u.name));
  return {
    unit: isRosterUnit ? S.who.unit : '',
    name: S.who.name.trim(),
    item: o.item, size: o.size, sugar: o.sugar, ice: o.ice, note: (o.note ?? '').trim(),
    toppings: o.toppings.map((t) => (typeof t === 'string' ? t : t.n)),
  };
}

function loadIntoForm(o, shop) {
  Object.assign(S.f, {
    item: o.item, size: o.size, sugar: o.sugar, ice: o.ice, note: o.note,
    tops: o.toppings.map((t) => t.n).filter((n) => shop?.toppings.some((t) => t.n === n)),
  });
}

function pickerTarget() {
  return S.modal?.picked;
}

const actions = {
  reload: () => refresh(),
  tab: (el) => { S.tab = el.dataset.v; S.armed = null; render(); },
  gate: () => { S.modal = { type: 'gate', pw: '' }; render(); },
  logout: () => { setPw(null); S.menu.dirty = false; S.roster.dirty = false; reconcile(); render(); },
  closeModal: () => { S.modal = null; render(); },
  overlay: (el, e) => { if (e.target === el) actions.closeModal(); },
  async unlock() {
    const pw = S.modal?.pw;
    if (!pw || S.busy) return;
    S.busy = true;
    render();
    try {
      await S.backend.adminCheck(pw);
      setPw(pw);
      S.modal = null;
      toast('已解鎖管理功能');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      S.busy = false;
      render();
    }
  },
  confirm(el) {
    const key = el.dataset.key;
    if (S.armed !== key) {
      S.armed = key;
      clearTimeout(actions._armT);
      actions._armT = setTimeout(() => { if (S.armed === key) { S.armed = null; render(); } }, 3000);
      render();
      return;
    }
    S.armed = null;
    const [kind, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (kind === 'delShop') {
      run(() => S.backend.deleteShop(S.pw, id), '已刪除店家').then((ok) => { if (ok) { S.menu.dirty = false; S.menu.selId = null; reconcile(); render(); } });
    } else if (kind === 'delUnit') {
      editRoster((d) => d.splice(d.findIndex((u) => u.key === id), 1));
    }
  },
  pick(el) {
    setPath(el.dataset.bind, el.dataset.v);
    render();
  },
  step(el) {
    const v = Math.min(30, Math.max(1, getPath(el.dataset.bind) + Number(el.dataset.d)));
    setPath(el.dataset.bind, v);
    render();
  },

  // ---- 開團
  newSession() {
    S.modal = { type: 'newSession', title: defaultTitle(), shopId: S.data.shops[0]?.id, who: '名單上所有人', picked: allPeople(S.data.units) };
    render();
  },
  async createSession() {
    const md = S.modal;
    if (!md.shopId) return toast('請先選一家飲料店', 'err');
    if (!md.title.trim()) return toast('請輸入團名', 'err');
    const pick = md.who === '指定這次的成員';
    if (pick && !md.picked.length) return toast('請至少勾選一位成員，或改選「名單上所有人」', 'err');
    const id = await run(() => S.backend.createSession(md.title.trim(), md.shopId, pick ? md.picked : null), '已開團，可以分享連結給同事了');
    if (id) { S.sid = id; S.modal = null; S.f = newForm(); S.tab = 'order'; reconcile(); render(); }
  },
  editParticipants() {
    const cur = current();
    S.modal = { type: 'participants', picked: (cur.participants ?? allPeople(S.data.units)).map((p) => ({ ...p })) };
    render();
  },
  async participantsAll() {
    if (await run(() => S.backend.setParticipants(current().id, null), '成員已更新')) { S.modal = null; render(); }
  },
  async participantsSave() {
    if (!S.modal.picked.length) return toast('請至少勾選一位成員', 'err');
    if (await run(() => S.backend.setParticipants(current().id, S.modal.picked), '成員已更新')) { S.modal = null; render(); }
  },
  pickAll() { S.modal.picked = allPeople(S.data.units); render(); },
  pickNone() { S.modal.picked = []; render(); },
  pickUnit(el) {
    const unit = el.dataset.unit;
    const u = S.data.units.find((x) => x.name === unit);
    const rest = pickerTarget().filter((p) => p.unit !== unit);
    S.modal.picked = el.dataset.on === '1' ? [...rest, ...u.members.map((name) => ({ unit, name }))] : rest;
    render();
  },
  pickOne(el) {
    const { unit, name } = el.dataset;
    const list = pickerTarget();
    const has = list.some((p) => p.unit === unit && p.name === name);
    S.modal.picked = has ? list.filter((p) => !(p.unit === unit && p.name === name)) : [...list, { unit, name }];
    render();
  },
  share() {
    const url = `${location.origin}${location.pathname}?g=${encodeURIComponent(current().id)}`;
    copyText(url, '連結已複製，貼到 LINE 就可以了');
  },
  close: () => run(() => S.backend.setStatus(current().id, 'closed'), '已結束訂購'),
  reopen: () => run(() => S.backend.setStatus(current().id, 'open'), '已重新開放'),

  // ---- 訂購
  pickPerson(el) {
    S.who = { unit: el.dataset.unit, name: el.dataset.name };
    store.set(WHO_KEY, JSON.stringify(S.who));
    S.f.editId = null;
    toast(`已切換為 ${el.dataset.name}`);
    render();
  },
  pickItem(el) {
    const shop = shopOf(current());
    const it = shop.items.find((i) => i.n === el.dataset.v);
    S.f.item = it.n;
    S.f.size = shop.sizes.find((_, i) => it.p[i] != null) ?? '';
    render();
  },
  toggleTop(el) {
    const n = el.dataset.v;
    S.f.tops = S.f.tops.includes(n) ? S.f.tops.filter((x) => x !== n) : [...S.f.tops, n];
    render();
  },
  async submitOrder() {
    const f = S.f;
    const cur = current();
    if (!S.who.name.trim()) return toast('請先選擇或輸入你的姓名', 'err');
    if (!f.item) return toast('請選一杯飲料', 'err');
    if (!f.size) return toast('這個規格沒有販售，請換一個規格', 'err');
    const fields = orderFields({ ...f, toppings: f.tops });
    const ok = f.editId
      ? await run(() => S.backend.updateOrder(f.editId, fields), '已更新訂單')
      : await run(() => S.backend.addOrder(cur.id, fields, f.qty), (r) => `已加入 ${r.count} 杯：${drinkLabel({ ...fields, toppings: fields.toppings.map((n) => ({ n })) })}`);
    if (ok) { S.f = { ...newForm(), q: f.q }; render(); }
  },
  cancelEdit() { S.f = { ...newForm(), q: S.f.q }; render(); },
  loadFav(el) {
    const shop = shopOf(current());
    const fav = favsFor(S.who.name.trim(), S.data.orders, shop)[Number(el.dataset.i)];
    if (!fav) return;
    loadIntoForm(fav, shop);
    S.f.editId = null;
    render();
    document.getElementById('drink')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  async reorder(el) {
    const cur = current();
    const fav = favsFor(S.who.name.trim(), S.data.orders, shopOf(cur))[Number(el.dataset.i)];
    if (!fav) return;
    if (!S.who.name.trim()) return toast('請先選擇你的姓名', 'err');
    const n = S.favQty;
    await run(() => S.backend.addOrder(cur.id, orderFields(fav), n), `已再訂 ${n} 杯：${drinkLabel(fav)}`);
  },
  editOrder(el) {
    const o = S.data.orders.find((x) => x.id === el.dataset.id);
    if (!o) return;
    loadIntoForm(o, shopOf(current()));
    S.f.editId = o.id;
    render();
    document.getElementById('drink')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  delOrder: (el) => run(() => S.backend.deleteOrder(el.dataset.id), '已刪除這杯'),

  // ---- 彙總
  copySummary() {
    const cur = current();
    copyText(summaryText(cur, sessionOrders(cur), shopOf(cur)?.phone), '彙總已複製，可貼給店家');
  },
  copyDetail() {
    copyText(detailText(sessionOrders(current()), S.data.units), '明細已複製，可貼到 Excel');
  },
  printSheet() {
    const url = sheetUrl();
    if (!url) return;
    if (!window.open(url, '_blank')) toast('瀏覽器擋住了新視窗，請改按「下載分發單」', 'err');
  },
  downloadSheet() {
    const url = sheetUrl();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `${current().title}-分發單.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  // ---- 菜單管理
  async addShop() {
    const m = S.menu;
    if (!m.newName.trim()) return;
    const id = await run(() => S.backend.saveShop(S.pw, { name: m.newName.trim(), phone: m.newPhone.trim(), sizes: ['中杯', '大杯'], items: [], toppings: [] }), '已新增店家，接著匯入菜單吧');
    if (id) { m.newName = ''; m.newPhone = ''; m.dirty = false; m.selId = id; reconcile(); render(); }
  },
  async saveShop() {
    const m = S.menu;
    const d = m.draft;
    if (!d.name.trim()) return toast('店名不能空白', 'err');
    const shop = {
      id: m.selId, name: d.name.trim(), phone: d.phone.trim(),
      sizes: d.sizes.map((s) => s.trim() || '規格'),
      items: d.items.filter((i) => i.n.trim()).map((i) => ({ n: i.n.trim(), p: d.sizes.map((_, k) => i.p[k] ?? null) })),
      toppings: d.toppings.filter((t) => t.n.trim()).map((t) => ({ n: t.n.trim(), p: t.p })),
    };
    if (await run(() => S.backend.saveShop(S.pw, shop), '菜單已儲存')) { m.dirty = false; reconcile(); render(); }
  },
  addSize: () => editMenu((d) => { d.sizes.push(`規格${d.sizes.length + 1}`); d.items.forEach((it) => it.p.push(null)); }),
  delSize: (el) => editMenu((d) => { const i = Number(el.dataset.i); d.sizes.splice(i, 1); d.items.forEach((it) => it.p.splice(i, 1)); }),
  addItem: () => { S.menu.filter = ''; editMenu((d) => d.items.unshift({ key: nk(), n: '', p: d.sizes.map(() => null) })); },
  delItem: (el) => editMenu((d) => d.items.splice(Number(el.dataset.i), 1)),
  addTop: () => editMenu((d) => d.toppings.push({ key: nk(), n: '', p: 0 })),
  delTop: (el) => editMenu((d) => d.toppings.splice(Number(el.dataset.i), 1)),
  pasteTops() {
    const text = S.menu.topPaste;
    S.menu.topPaste = '';
    editMenu((d) => { d.toppings = mergeToppings(d.toppings, parseToppingsText(text), 'append').map((t) => ({ key: t.key ?? nk(), ...t })); });
  },
  importMenu() { S.modal = { type: 'importMenu', text: '', topText: '', mode: '加入到現有菜單' }; render(); },
  applyMenu() {
    const md = S.modal;
    const p = parsedMenu(md);
    if (!p) return toast('沒有讀到任何品項', 'err');
    const d = S.menu.draft;
    const res = applyMenu({ sizes: d.sizes, items: d.items, toppings: d.toppings }, p, md.mode === '取代整份菜單' ? 'replace' : 'append');
    S.modal = null;
    editMenu((dr) => {
      dr.sizes = res.sizes;
      dr.items = res.items.map((i) => ({ key: nk(), n: i.n, p: i.p }));
      dr.toppings = (res.toppings ?? dr.toppings).map((t) => ({ key: nk(), n: t.n, p: t.p }));
    });
    toast('已套用到草稿，記得按「儲存菜單」');
  },
  exportMenu() {
    const d = S.menu.draft;
    const shop = {
      sizes: d.sizes.map((s) => s.trim() || '規格'),
      items: d.items.filter((i) => i.n.trim()).map((i) => ({ n: i.n.trim(), p: i.p })),
      toppings: d.toppings.filter((t) => t.n.trim()).map((t) => ({ n: t.n.trim(), p: t.p })),
    };
    downloadCSV(menuToCSV(shop), `${d.name.trim() || '菜單'}-菜單.csv`);
    toast(S.menu.dirty ? '已匯出（含尚未儲存的修改）' : '菜單已匯出');
  },
  pickFile: (el) => document.getElementById(el.dataset.target)?.click(),

  // ---- 名單管理
  addUnit() {
    const n = S.roster.newUnit.trim();
    if (!n) return;
    if (S.roster.draft.some((u) => u.name.trim() === n)) return toast('已經有同名的單位', 'err');
    S.roster.newUnit = '';
    editRoster((d) => d.push({ key: nk(), name: n, members: [] }));
  },
  addMembers(el) {
    const key = el.dataset.key;
    const names = (S.roster.add[key] ?? '').split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!names.length) return;
    S.roster.add[key] = '';
    editRoster((d) => { const u = d.find((x) => x.key === key); u.members = Array.from(new Set([...u.members, ...names])); });
  },
  removeMember(el) {
    editRoster((d) => { const u = d.find((x) => x.key === el.dataset.key); u.members = u.members.filter((m) => m !== el.dataset.v); });
  },
  importRoster() { S.modal = { type: 'importRoster', text: '', mode: '合併到現有名單' }; render(); },
  applyRoster() {
    const md = S.modal;
    const incoming = parseRoster(md.text);
    const draft = S.roster.draft;
    const merged = mergeRoster(draft.map((u) => ({ name: u.name, members: u.members })), incoming, md.mode === '取代整份名單' ? 'replace' : 'merge');
    S.modal = null;
    editRoster((d) => {
      const next = merged.map((m) => { const old = draft.find((u) => u.name === m.name); return { key: old?.key ?? nk(), id: old?.id, name: m.name, members: m.members }; });
      d.splice(0, d.length, ...next);
    });
    toast('已套用到草稿，記得按「儲存名單」');
  },
  exportRoster() {
    const d = S.roster.draft.filter((u) => u.name.trim());
    const name = '辦公室';
    downloadCSV(rosterToCSV(d.map((u) => ({ name: u.name.trim(), members: u.members }))), `${name}-名單.csv`);
    toast(S.roster.dirty ? '已匯出（含尚未儲存的修改）' : '名單已匯出');
  },
  async saveRoster() {
    const d = S.roster.draft;
    if (d.some((u) => !u.name.trim())) return toast('單位名稱不能空白', 'err');
    const names = d.map((u) => u.name.trim());
    if (new Set(names).size !== names.length) return toast('單位名稱不能重複', 'err');
    if (await run(() => S.backend.saveRoster(S.pw, d.map((u) => ({ id: u.id, name: u.name.trim(), members: u.members }))), '名單已儲存')) {
      S.roster.dirty = false;
      reconcile();
      render();
    }
  },
};

// 下載 CSV（檔名去掉 Windows 不允許的字元）
function downloadCSV(text, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = filename.replace(/[\\/:*?"<>|]/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function sheetUrl() {
  const cur = current();
  const orders = sessionOrders(cur);
  if (!orders.length) { toast('還沒有訂單', 'err'); return null; }
  return URL.createObjectURL(new Blob([sheetHTML(cur, orders, S.data.units, shopOf(cur)?.phone)], { type: 'text/html;charset=utf-8' }));
}

const changes = {
  session(el) {
    S.sid = el.value;
    S.f = newForm();
    S.armed = null;
    syncUrl();
    render();
  },
  whoUnit(el) {
    S.who = { unit: el.value, name: '' };
    store.set(WHO_KEY, JSON.stringify(S.who));
    S.f.editId = null;
    render();
  },
  whoName(el) {
    S.who = { ...S.who, name: el.value };
    store.set(WHO_KEY, JSON.stringify(S.who));
    S.f.editId = null;
    render();
  },
  nsShop(el) { S.modal.shopId = el.value; },
  menuShop(el) {
    if (S.menu.dirty && !confirm('目前的修改還沒儲存，確定要切換嗎？')) { el.value = S.menu.selId; return; }
    S.menu.selId = el.value;
    S.menu.dirty = false;
    S.menu.filter = '';
    reconcile();
    render();
  },
  async menuFile(el) {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    try { S.modal.text = await readTextFile(f); render(); } catch { toast('讀取檔案失敗', 'err'); }
  },
  async rosterFile(el) {
    const f = el.files?.[0];
    el.value = '';
    if (!f) return;
    try { S.modal.text = await readTextFile(f); render(); } catch { toast('讀取檔案失敗', 'err'); }
  },
};

// ---------------------------------------------------------------- 事件

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  if (el.dataset.act !== 'confirm' && S.armed && el.dataset.act !== 'overlay') S.armed = null;
  fn(el, e);
});

document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (el) changes[el.dataset.change]?.(el);
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    setPath(el.dataset.bind, el.value);
    if (el.dataset.dirty) S[el.dataset.dirty].dirty = true;
    if (el.dataset.bind === 'who.name') { store.set(WHO_KEY, JSON.stringify(S.who)); S.f.editId = null; }
    if (el.dataset.rerender !== undefined || el.dataset.dirty) {
      if (e.isComposing) pendingRender = true; else render();
    }
    return;
  }
  if (el.dataset.price) {
    const [idx, si] = el.dataset.price.split(':').map(Number);
    const v = el.value.replace(/[^\d]/g, '');
    if (v !== el.value) el.value = v;
    S.menu.draft.items[idx].p[si] = v === '' ? null : parseInt(v, 10);
    S.menu.dirty = true;
    render();
  } else if (el.dataset.tprice) {
    const v = el.value.replace(/[^\d]/g, '');
    if (v !== el.value) el.value = v;
    S.menu.draft.toppings[Number(el.dataset.tprice)].p = v === '' ? 0 : Math.min(1000, parseInt(v, 10));
    S.menu.dirty = true;
    render();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.modal) { actions.closeModal(); return; }
  if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
  const el = e.target.closest('[data-enter]');
  if (!el) return;
  e.preventDefault();
  actions[el.dataset.enter]?.(el, e);
});

document.addEventListener('compositionstart', () => { composing = true; });
document.addEventListener('compositionend', () => {
  composing = false;
  if (pendingRender) setTimeout(render, 0);
});

window.addEventListener('beforeunload', (e) => {
  if (S.pw && (S.menu.dirty || S.roster.dirty)) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

// ---------------------------------------------------------------- 啟動

(async () => {
  render();
  try {
    S.backend = await createBackend({ demo: DEMO });
  } catch (e) {
    S.error = `無法載入資料庫元件：${e.message}`;
    render();
    return;
  }
  await refresh();
  S.backend.subscribe(scheduleRefresh, setLive);
  setLive('connecting');
})();

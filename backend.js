import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export class AdminError extends Error {}

function friendlyError(error) {
  const msg = String(error?.message || error || '');
  if (/failed to fetch|network/i.test(msg)) return new Error('網路連線失敗，請檢查網路後再試');
  if (/od_/.test(msg) && /schema cache|does not exist|could not find/i.test(msg)) return new Error('資料庫尚未設定，請先執行 supabase/setup.sql');
  return new Error(msg || '發生未知錯誤');
}

// 資料庫函式回傳 {ok, error, code}
function unwrap(res) {
  if (!res || res.ok !== true) {
    const msg = res?.error || '操作失敗';
    throw res?.code === 'admin' ? new AdminError(msg) : new Error(msg);
  }
  return res;
}

const normShop = (s) => ({ ...s, sizes: s.sizes ?? [], items: s.items ?? [], toppings: s.toppings ?? [] });
const normOrder = (o) => ({ ...o, toppings: o.toppings ?? [] });

export async function createBackend({ demo }) {
  return demo ? createDemoBackend() : createSupabaseBackend();
}

// ---------------------------------------------------------------- Supabase

async function createSupabaseBackend() {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const check = ({ data, error }) => {
    if (error) throw friendlyError(error);
    return data;
  };
  const rpc = async (fn, args) => unwrap(check(await sb.rpc(fn, args)));

  // 一次最多回 1000 筆，訂單要分頁讀
  async function allOrders() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = check(await sb.from('od_orders').select('*').order('created_at').order('id').range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) return out;
    }
  }

  return {
    async load() {
      const [shops, units, sessions, orders] = await Promise.all([
        sb.from('od_shops').select('*').order('created_at'),
        sb.from('od_units').select('*').order('ord'),
        sb.from('od_sessions').select('*').order('created_at', { ascending: false }).limit(100),
        allOrders(),
      ]);
      return {
        shops: check(shops).map(normShop),
        units: check(units).map((u) => ({ ...u, members: u.members ?? [] })),
        sessions: check(sessions),
        orders: orders.map(normOrder),
      };
    },
    subscribe(onChange, onStatus = () => {}) {
      const channel = sb.channel('office-drinks');
      for (const table of ['od_shops', 'od_units', 'od_sessions', 'od_orders']) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, onChange);
      }
      channel.subscribe((status) => onStatus(status));
      return () => sb.removeChannel(channel);
    },

    addOrder: (sessionId, order, qty) => rpc('od_order_add', { p_session: sessionId, p_order: order, p_qty: qty }),
    updateOrder: (id, order) => rpc('od_order_update', { p_id: id, p_order: order }),
    deleteOrder: (id) => rpc('od_order_delete', { p_id: id }),

    createSession: async (title, shopId, participants) =>
      (await rpc('od_session_create', { p_title: title, p_shop: shopId, p_participants: participants })).id,
    setParticipants: (id, participants) => rpc('od_session_set_participants', { p_id: id, p_participants: participants }),
    setStatus: (id, status) => rpc('od_session_set_status', { p_id: id, p_status: status }),

    adminCheck: (pw) => rpc('od_admin_check', { p_password: pw }),
    saveShop: async (pw, shop) => (await rpc('od_shop_save', { p_password: pw, p_shop: shop })).id,
    deleteShop: (pw, id) => rpc('od_shop_delete', { p_password: pw, p_id: id }),
    saveRoster: (pw, units) => rpc('od_roster_save', { p_password: pw, p_units: units }),
  };
}

// ---------------------------------------------------------------- 示範模式（資料只在這個分頁）

function createDemoBackend() {
  const DEMO_PASSWORD = 'demo1234';
  const uid = (n = 10) => Math.random().toString(36).slice(2, 2 + n).padEnd(n, '0');
  const now = () => new Date().toISOString();
  const t0 = Date.now() - 3 * 86400000;
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  const db = {
    shops: [
      {
        id: 'demo-shop-1', name: '示範茶飲', phone: '04-1234-5678', created_at: at(0),
        sizes: ['中杯', '大杯'],
        items: [
          { n: '珍珠奶茶', p: [45, 55] }, { n: '四季春青茶', p: [30, 35] }, { n: '檸檬綠茶', p: [40, 50] },
          { n: '冬瓜檸檬', p: [40, 50] }, { n: '紅茶拿鐵', p: [50, 60] }, { n: '黑糖鮮奶', p: [null, 70] },
          { n: '多多綠茶', p: [45, 55] }, { n: '烏龍奶茶', p: [45, 55] }, { n: '蜂蜜檸檬', p: [55, 65] },
        ],
        toppings: [{ n: '珍珠', p: 10 }, { n: '椰果', p: 10 }, { n: '仙草凍', p: 0 }],
      },
      {
        id: 'demo-shop-2', name: '示範果汁', phone: '', created_at: at(1),
        sizes: ['大杯'], items: [{ n: '柳橙汁', p: [60] }, { n: '芒果冰沙', p: [80] }], toppings: [],
      },
    ],
    units: [
      { id: 'u1', name: '總務課', members: ['王小明', '李大華', '陳美玲', '林志豪'], ord: 0 },
      { id: 'u2', name: '工務課', members: ['張家豪', '黃怡君', '吳建宏'], ord: 1 },
      { id: 'u3', name: '資訊室', members: ['周子豪', '許雅婷'], ord: 2 },
    ],
    sessions: [
      { id: 'demo-old', title: '上週飲料團', shop_id: 'demo-shop-1', shop_name: '示範茶飲', status: 'closed', participants: null, created_at: at(10) },
      { id: 'demo-now', title: '示範飲料團', shop_id: 'demo-shop-1', shop_name: '示範茶飲', status: 'open', participants: null, created_at: at(3000) },
    ],
    orders: [],
  };
  const seed = [
    ['demo-old', '總務課', '王小明', '珍珠奶茶', '大杯', '半糖', '少冰', ['椰果']],
    ['demo-old', '總務課', '李大華', '四季春青茶', '大杯', '無糖', '去冰', []],
    ['demo-now', '總務課', '李大華', '四季春青茶', '大杯', '無糖', '去冰', []],
    ['demo-now', '工務課', '張家豪', '紅茶拿鐵', '中杯', '微糖', '微冰', ['珍珠']],
  ];
  seed.forEach(([sid, unit, name, item, size, sugar, ice, tops], i) => {
    const shop = db.shops[0];
    const it = shop.items.find((x) => x.n === item);
    const toppings = tops.map((n) => shop.toppings.find((t) => t.n === n));
    db.orders.push({ id: uid(12), session_id: sid, unit, name, item, size, sugar, ice, note: '', toppings,
      price: it.p[shop.sizes.indexOf(size)] + toppings.reduce((s, t) => s + t.p, 0), created_at: at(20 + i * 1500) });
  });

  const listeners = new Set();
  const emit = () => setTimeout(() => listeners.forEach((fn) => fn()), 30);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const fail = (msg, code) => { throw code === 'admin' ? new AdminError(msg) : new Error(msg); };
  const txt = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  let failed = 0;
  let lockedUntil = 0;
  const admin = (pw) => {
    if (lockedUntil > Date.now()) fail(`密碼錯誤次數過多，請 ${Math.ceil((lockedUntil - Date.now()) / 60000)} 分鐘後再試`, 'admin');
    if (pw === DEMO_PASSWORD) { failed = 0; return; }
    failed += 1;
    if (failed >= 5) { failed = 0; lockedUntil = Date.now() + 5 * 60000; fail('密碼錯誤次數過多，請 5 分鐘後再試', 'admin'); }
    fail('管理密碼錯誤', 'admin');
  };
  // 與資料庫 od__build_order 相同的規則
  const buildOrder = (shopId, o) => {
    const name = txt(o?.name, 40);
    const item = txt(o?.item, 100);
    const size = txt(o?.size, 20);
    if (!name) fail('請先選擇或輸入你的姓名');
    if (!item) fail('請選一杯飲料');
    const shop = db.shops.find((s) => s.id === shopId);
    if (!shop) fail('這個團的飲料店已被刪除');
    const it = shop.items.find((x) => x.n === item);
    if (!it) fail(`「${item}」已不在菜單上`);
    const idx = shop.sizes.indexOf(size);
    if (idx < 0 || typeof it.p[idx] !== 'number') fail('這個規格沒有販售，請換一個規格');
    if ((o.toppings ?? []).length > 10) fail('加料最多 10 種');
    const toppings = [];
    for (const t of o.toppings ?? []) {
      const n = typeof t === 'object' ? t.n : t;
      const hit = shop.toppings.find((x) => x.n === n);
      if (!hit) fail(`加料「${n}」已不在菜單上`);
      if (!toppings.includes(hit)) toppings.push(hit);
    }
    return { unit: txt(o.unit, 60), name, item, size, price: it.p[idx] + toppings.reduce((s, t) => s + t.p, 0),
      toppings: clone(toppings), sugar: txt(o.sugar, 20), ice: txt(o.ice, 20), note: txt(o.note, 100) };
  };
  const openSession = (id) => {
    const s = db.sessions.find((x) => x.id === id);
    if (!s) fail('找不到這個團');
    if (s.status !== 'open') fail('這個團已經結束訂購了');
    return s;
  };
  const sessionOf = (orderId) => {
    const o = db.orders.find((x) => x.id === orderId);
    return o && db.sessions.find((s) => s.id === o.session_id);
  };
  const participants = (p) => (p == null ? null : p.map((x) => ({ unit: txt(x.unit, 60), name: txt(x.name, 40) })).filter((x) => x.name));
  const done = (extra = {}) => { emit(); return { ok: true, ...extra }; };

  return {
    isDemo: true,
    demoPassword: DEMO_PASSWORD,
    async load() {
      return {
        shops: clone([...db.shops].sort((a, b) => a.created_at.localeCompare(b.created_at))),
        units: clone([...db.units].sort((a, b) => a.ord - b.ord)),
        sessions: clone([...db.sessions].sort((a, b) => b.created_at.localeCompare(a.created_at))),
        orders: clone([...db.orders].sort((a, b) => a.created_at.localeCompare(b.created_at))),
      };
    },
    subscribe(onChange, onStatus = () => {}) {
      listeners.add(onChange);
      setTimeout(() => onStatus('SUBSCRIBED'), 0);
      return () => listeners.delete(onChange);
    },

    async addOrder(sessionId, order, qty) {
      const s = openSession(sessionId);
      if (!(qty >= 1 && qty <= 30)) fail('杯數需在 1～30 之間');
      const o = buildOrder(s.shop_id, order);
      for (let i = 0; i < qty; i++) db.orders.push({ id: uid(12), session_id: s.id, ...clone(o), created_at: now() });
      return done({ count: qty, price: o.price });
    },
    async updateOrder(id, order) {
      const s = sessionOf(id);
      if (!s) fail('找不到這筆訂單');
      if (s.status !== 'open') fail('這個團已經結束訂購了');
      Object.assign(db.orders.find((x) => x.id === id), buildOrder(s.shop_id, order));
      return done();
    },
    async deleteOrder(id) {
      const s = sessionOf(id);
      if (!s) return { ok: true };
      if (s.status !== 'open') fail('這個團已經結束訂購了，不能刪除訂單');
      db.orders = db.orders.filter((x) => x.id !== id);
      return done();
    },

    async createSession(title, shopId, parts) {
      const t = txt(title, 60);
      if (!t) fail('請輸入團名');
      const shop = db.shops.find((s) => s.id === shopId);
      if (!shop) fail('找不到這家飲料店');
      const id = uid(10);
      db.sessions.push({ id, title: t, shop_id: shop.id, shop_name: shop.name, status: 'open', participants: participants(parts), created_at: now() });
      emit();
      return id;
    },
    async setParticipants(id, parts) {
      const s = db.sessions.find((x) => x.id === id);
      if (!s) fail('找不到這個團');
      s.participants = participants(parts);
      return done();
    },
    async setStatus(id, status) {
      const s = db.sessions.find((x) => x.id === id);
      if (!s) fail('找不到這個團');
      s.status = status;
      return done();
    },

    async adminCheck(pw) { admin(pw); return { ok: true }; },
    async saveShop(pw, shop) {
      admin(pw);
      const name = txt(shop.name, 60);
      if (!name) fail('店名不能空白');
      if (!(shop.sizes?.length >= 1 && shop.sizes.length <= 8)) fail('規格需要 1～8 個');
      const sizes = shop.sizes.map((s) => txt(s, 20) || '規格');
      const items = (shop.items ?? []).filter((i) => txt(i.n, 100)).map((i) => ({
        n: txt(i.n, 100), p: sizes.map((_, k) => (typeof i.p[k] === 'number' && i.p[k] >= 0 ? Math.round(i.p[k]) : null)),
      }));
      const toppings = (shop.toppings ?? []).filter((t) => txt(t.n, 40)).map((t) => ({
        n: txt(t.n, 40), p: typeof t.p === 'number' ? Math.min(1000, Math.max(0, Math.round(t.p))) : 0,
      }));
      if (items.length > 500) fail('品項最多 500 個');
      const row = { name, phone: txt(shop.phone, 30), sizes, items, toppings };
      if (shop.id) {
        const hit = db.shops.find((s) => s.id === shop.id);
        if (!hit) fail('找不到這家飲料店，可能已被刪除');
        Object.assign(hit, row);
        emit();
        return hit.id;
      }
      const id = uid(10);
      db.shops.push({ id, ...row, created_at: now() });
      emit();
      return id;
    },
    async deleteShop(pw, id) {
      admin(pw);
      db.shops = db.shops.filter((s) => s.id !== id);
      return done();
    },
    async saveRoster(pw, units) {
      admin(pw);
      const names = units.map((u) => txt(u.name, 60));
      if (names.some((n) => !n)) fail('單位名稱不能空白');
      const dup = names.find((n, i) => names.indexOf(n) !== i);
      if (dup) fail(`單位「${dup}」重複了`);
      db.units = units.map((u, i) => ({
        id: u.id && db.units.some((x) => x.id === u.id) ? u.id : uid(10),
        name: names[i],
        members: Array.from(new Set((u.members ?? []).map((m) => txt(m, 40)).filter(Boolean))).slice(0, 300),
        ord: i,
      }));
      return done();
    },
  };
}

-- =====================================================================
-- 辦公室飲料訂購：Supabase 資料庫設定
-- 資料表一律以 od_ 開頭，可以和其他系統共用同一個 Supabase 專案。
-- 用法：Supabase → SQL Editor → New query → 貼上全部內容 → Run
-- 可以重複執行，不會清掉已有的資料。
-- 執行完記得做第 6 段：設定管理密碼。
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- 1. 資料表 ----------

create table if not exists public.od_shops (
  id         text primary key,
  name       text not null check (char_length(name) between 1 and 60),
  phone      text not null default '' check (char_length(phone) <= 30),
  sizes      jsonb not null default '[]'::jsonb,  -- ["中杯","大杯"]
  items      jsonb not null default '[]'::jsonb,  -- [{"n":"珍珠奶茶","p":[50,60]}]，p 依 sizes 順序，null = 沒賣
  toppings   jsonb not null default '[]'::jsonb,  -- [{"n":"珍珠","p":10}]
  created_at timestamptz not null default now()
);

create table if not exists public.od_units (
  id      text primary key,
  name    text not null unique check (char_length(name) between 1 and 60),
  members jsonb not null default '[]'::jsonb,     -- ["王小明","李大華"]
  ord     int  not null default 0
);

create table if not exists public.od_sessions (
  id           text primary key,
  title        text not null check (char_length(title) between 1 and 60),
  shop_id      text not null,
  shop_name    text not null,
  status       text not null default 'open' check (status in ('open', 'closed')),
  participants jsonb,                             -- null = 名單上所有人；[{"unit":"W5S1","name":"王小明"}]
  created_at   timestamptz not null default now()
);

create table if not exists public.od_orders (
  id         text primary key,
  session_id text not null references public.od_sessions(id) on delete cascade,
  unit       text not null default '',
  name       text not null,
  item       text not null,
  size       text not null default '',
  price      int,                                 -- 含加料的單杯價格（由資料庫依菜單計算）
  toppings   jsonb not null default '[]'::jsonb,  -- [{"n":"珍珠","p":10}]
  sugar      text not null default '',
  ice        text not null default '',
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists od_orders_session_idx on public.od_orders (session_id, created_at);

-- 管理密碼（加密儲存，網頁讀不到，只能透過下方函式驗證）
create table if not exists public.od_admin (
  id           int primary key default 1 check (id = 1),
  pw_hash      text,
  failed       int not null default 0,
  locked_until timestamptz
);
insert into public.od_admin (id) values (1) on conflict (id) do nothing;

-- ---------- 2. 安全規則：大家都能讀，寫入一律透過下方函式 ----------

alter table public.od_shops    enable row level security;
alter table public.od_units    enable row level security;
alter table public.od_sessions enable row level security;
alter table public.od_orders   enable row level security;
alter table public.od_admin    enable row level security;  -- 沒有任何規則 = 網頁完全讀寫不到

drop policy if exists od_shops_read    on public.od_shops;
drop policy if exists od_units_read    on public.od_units;
drop policy if exists od_sessions_read on public.od_sessions;
drop policy if exists od_orders_read   on public.od_orders;
create policy od_shops_read    on public.od_shops    for select using (true);
create policy od_units_read    on public.od_units    for select using (true);
create policy od_sessions_read on public.od_sessions for select using (true);
create policy od_orders_read   on public.od_orders   for select using (true);

-- ---------- 3. 共用函式 ----------

create or replace function public.od__id(n int default 12) returns text
language sql volatile set search_path = public as $$
  select substr(translate(encode(extensions.gen_random_bytes(16), 'base64'), '+/=', 'xyz'), 1, n)
$$;

create or replace function public.od__fail(msg text, code text default null) returns jsonb
language sql immutable as $$ select jsonb_build_object('ok', false, 'error', msg, 'code', code) $$;

create or replace function public.od__txt(v jsonb, max_len int) returns text
language sql immutable as $$
  select case when jsonb_typeof(v) = 'string' then left(btrim(v #>> '{}'), max_len) else '' end
$$;

-- 驗證管理密碼：錯 5 次鎖 5 分鐘。回傳 null = 通過，否則是錯誤訊息
-- （失敗次數要寫回資料表，所以不能用 raise 中斷交易）
create or replace function public.od__check_admin(p_password text) returns text
language plpgsql security definer set search_path = public as $$
declare a public.od_admin;
begin
  select * into a from public.od_admin where id = 1 for update;
  if a.pw_hash is null then
    return '尚未設定管理密碼，請在 Supabase 執行 setup.sql 第 6 段';
  end if;
  if a.locked_until is not null and a.locked_until > now() then
    return format('密碼錯誤次數過多，請 %s 分鐘後再試', ceil(extract(epoch from (a.locked_until - now())) / 60)::int);
  end if;
  if p_password is not null and extensions.crypt(p_password, a.pw_hash) = a.pw_hash then
    if a.failed > 0 or a.locked_until is not null then
      update public.od_admin set failed = 0, locked_until = null where id = 1;
    end if;
    return null;
  end if;
  if a.failed + 1 >= 5 then
    update public.od_admin set failed = 0, locked_until = now() + interval '5 minutes' where id = 1;
    return '密碼錯誤次數過多，請 5 分鐘後再試';
  end if;
  update public.od_admin set failed = a.failed + 1 where id = 1;
  return '管理密碼錯誤';
end $$;

-- 依菜單算出訂單內容與價格（加料以目前菜單的加價為準）
create or replace function public.od__build_order(p_shop_id text, p_order jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  s public.od_shops;
  v_name text := public.od__txt(p_order->'name', 40);
  v_item text := public.od__txt(p_order->'item', 100);
  v_size text := public.od__txt(p_order->'size', 20);
  v_idx int;
  v_menu jsonb;
  v_base int;
  v_tops jsonb := '[]'::jsonb;
  v_t jsonb;
  v_tn text;
  v_hit jsonb;
begin
  if coalesce(jsonb_typeof(p_order), '') <> 'object' then return public.od__fail('訂單格式錯誤'); end if;
  if v_name = '' then return public.od__fail('請先選擇或輸入你的姓名'); end if;
  if v_item = '' then return public.od__fail('請選一杯飲料'); end if;
  select * into s from public.od_shops where id = p_shop_id;
  if not found then return public.od__fail('這個團的飲料店已被刪除'); end if;
  select (t.ord - 1)::int into v_idx from jsonb_array_elements_text(s.sizes) with ordinality t(v, ord) where t.v = v_size limit 1;
  select e into v_menu from jsonb_array_elements(s.items) e where e->>'n' = v_item limit 1;
  if v_menu is null then return public.od__fail(format('「%s」已不在菜單上', v_item)); end if;
  if v_idx is null or coalesce(jsonb_typeof(v_menu->'p'->v_idx), '') <> 'number' then
    return public.od__fail('這個規格沒有販售，請換一個規格');
  end if;
  v_base := (v_menu->'p'->>v_idx)::int;
  if coalesce(jsonb_typeof(coalesce(p_order->'toppings', '[]'::jsonb)), '') <> 'array' then return public.od__fail('加料格式錯誤'); end if;
  if jsonb_array_length(coalesce(p_order->'toppings', '[]'::jsonb)) > 10 then return public.od__fail('加料最多 10 種'); end if;
  for v_t in select * from jsonb_array_elements(coalesce(p_order->'toppings', '[]'::jsonb)) loop
    v_tn := case when jsonb_typeof(v_t) = 'object' then v_t->>'n' else v_t #>> '{}' end;
    select e into v_hit from jsonb_array_elements(s.toppings) e where e->>'n' = v_tn limit 1;
    if v_hit is null then return public.od__fail(format('加料「%s」已不在菜單上', v_tn)); end if;
    if not v_tops @> jsonb_build_array(v_hit) then
      v_tops := v_tops || jsonb_build_array(v_hit);
      v_base := v_base + coalesce((v_hit->>'p')::int, 0);
    end if;
  end loop;
  return jsonb_build_object('ok', true,
    'unit', public.od__txt(p_order->'unit', 60), 'name', v_name, 'item', v_item, 'size', v_size,
    'price', v_base, 'toppings', v_tops,
    'sugar', public.od__txt(p_order->'sugar', 20), 'ice', public.od__txt(p_order->'ice', 20),
    'note', public.od__txt(p_order->'note', 100));
end $$;

-- 檢查參加成員名單
create or replace function public.od__participants(p jsonb) returns jsonb
language plpgsql immutable as $$
declare v jsonb := '[]'::jsonb; e jsonb; n text;
begin
  if p is null or jsonb_typeof(p) = 'null' then return null; end if;
  if coalesce(jsonb_typeof(p), '') <> 'array' or jsonb_array_length(p) > 600 then raise exception 'bad participants'; end if;
  for e in select * from jsonb_array_elements(p) loop
    n := public.od__txt(e->'name', 40);
    if n <> '' then v := v || jsonb_build_array(jsonb_build_object('unit', public.od__txt(e->'unit', 60), 'name', n)); end if;
  end loop;
  return v;
end $$;

revoke execute on function public.od__check_admin(text) from public, anon, authenticated;
revoke execute on function public.od__build_order(text, jsonb) from public, anon, authenticated;

-- ---------- 4. 訂購與開團（不需管理密碼） ----------

create or replace function public.od_order_add(p_session text, p_order jsonb, p_qty int default 1)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.od_sessions; o jsonb; i int;
begin
  select * into v from public.od_sessions where id = p_session;
  if not found then return public.od__fail('找不到這個團'); end if;
  if v.status <> 'open' then return public.od__fail('這個團已經結束訂購了'); end if;
  if p_qty is null or p_qty < 1 or p_qty > 30 then return public.od__fail('杯數需在 1～30 之間'); end if;
  o := public.od__build_order(v.shop_id, p_order);
  if not (o->>'ok')::boolean then return o; end if;
  for i in 1..p_qty loop
    insert into public.od_orders (id, session_id, unit, name, item, size, price, toppings, sugar, ice, note)
    values (public.od__id(12), v.id, o->>'unit', o->>'name', o->>'item', o->>'size', (o->>'price')::int,
            o->'toppings', o->>'sugar', o->>'ice', o->>'note');
  end loop;
  return jsonb_build_object('ok', true, 'count', p_qty, 'price', (o->>'price')::int);
end $$;

create or replace function public.od_order_update(p_id text, p_order jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.od_sessions; o jsonb;
begin
  select s.* into v from public.od_orders r join public.od_sessions s on s.id = r.session_id where r.id = p_id;
  if not found then return public.od__fail('找不到這筆訂單'); end if;
  if v.status <> 'open' then return public.od__fail('這個團已經結束訂購了'); end if;
  o := public.od__build_order(v.shop_id, p_order);
  if not (o->>'ok')::boolean then return o; end if;
  update public.od_orders set unit = o->>'unit', name = o->>'name', item = o->>'item', size = o->>'size',
    price = (o->>'price')::int, toppings = o->'toppings', sugar = o->>'sugar', ice = o->>'ice', note = o->>'note'
  where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.od_order_delete(p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.od_sessions;
begin
  select s.* into v from public.od_orders r join public.od_sessions s on s.id = r.session_id where r.id = p_id;
  if not found then return jsonb_build_object('ok', true); end if;
  if v.status <> 'open' then return public.od__fail('這個團已經結束訂購了，不能刪除訂單'); end if;
  delete from public.od_orders where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.od_session_create(p_title text, p_shop text, p_participants jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.od_shops; v_id text := public.od__id(10); v_title text := left(btrim(coalesce(p_title, '')), 60);
begin
  if v_title = '' then return public.od__fail('請輸入團名'); end if;
  select * into s from public.od_shops where id = p_shop;
  if not found then return public.od__fail('找不到這家飲料店'); end if;
  begin
    insert into public.od_sessions (id, title, shop_id, shop_name, participants)
    values (v_id, v_title, s.id, s.name, public.od__participants(p_participants));
  exception when others then return public.od__fail('參加成員名單格式錯誤');
  end;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.od_session_set_participants(p_id text, p_participants jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  begin
    update public.od_sessions set participants = public.od__participants(p_participants) where id = p_id;
  exception when others then return public.od__fail('參加成員名單格式錯誤');
  end;
  if not found then return public.od__fail('找不到這個團'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.od_session_set_status(p_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('open', 'closed') then return public.od__fail('狀態錯誤'); end if;
  update public.od_sessions set status = p_status where id = p_id;
  if not found then return public.od__fail('找不到這個團'); end if;
  return jsonb_build_object('ok', true);
end $$;

-- 團不能刪除，只能結束訂購（舊版的刪除函式一併移除）
drop function if exists public.od_session_delete(text);

-- ---------- 5. 菜單與名單（需要管理密碼） ----------

create or replace function public.od_admin_check(p_password text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e text := public.od__check_admin(p_password);
begin
  if e is not null then return public.od__fail(e, 'admin'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.od_shop_save(p_password text, p_shop jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e text := public.od__check_admin(p_password);
  v_id text;
  v_name text;
  v_sizes jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_tops jsonb := '[]'::jsonb;
  x jsonb; n text; p jsonb; i int; v_p jsonb;
begin
  if e is not null then return public.od__fail(e, 'admin'); end if;
  if coalesce(jsonb_typeof(p_shop), '') <> 'object' then return public.od__fail('店家資料格式錯誤'); end if;
  v_name := public.od__txt(p_shop->'name', 60);
  if v_name = '' then return public.od__fail('店名不能空白'); end if;
  if coalesce(jsonb_typeof(p_shop->'sizes'), '') <> 'array' or jsonb_array_length(p_shop->'sizes') not between 1 and 8 then
    return public.od__fail('規格需要 1～8 個');
  end if;
  for x in select * from jsonb_array_elements(p_shop->'sizes') loop
    n := public.od__txt(x, 20);
    v_sizes := v_sizes || to_jsonb(case when n = '' then '規格' else n end);
  end loop;
  if coalesce(jsonb_typeof(coalesce(p_shop->'items', '[]'::jsonb)), '') <> 'array' or jsonb_array_length(coalesce(p_shop->'items', '[]'::jsonb)) > 500 then
    return public.od__fail('品項最多 500 個');
  end if;
  for x in select * from jsonb_array_elements(coalesce(p_shop->'items', '[]'::jsonb)) loop
    n := public.od__txt(x->'n', 100);
    if n = '' then continue; end if;
    v_p := '[]'::jsonb;
    for i in 0 .. jsonb_array_length(v_sizes) - 1 loop
      p := x->'p'->i;
      v_p := v_p || case when jsonb_typeof(p) = 'number' and (p #>> '{}')::numeric between 0 and 100000
                         then to_jsonb(round((p #>> '{}')::numeric)::int) else 'null'::jsonb end;
    end loop;
    v_items := v_items || jsonb_build_array(jsonb_build_object('n', n, 'p', v_p));
  end loop;
  if coalesce(jsonb_typeof(coalesce(p_shop->'toppings', '[]'::jsonb)), '') <> 'array' or jsonb_array_length(coalesce(p_shop->'toppings', '[]'::jsonb)) > 60 then
    return public.od__fail('加料最多 60 種');
  end if;
  for x in select * from jsonb_array_elements(coalesce(p_shop->'toppings', '[]'::jsonb)) loop
    n := public.od__txt(x->'n', 40);
    if n = '' then continue; end if;
    p := x->'p';
    v_tops := v_tops || jsonb_build_array(jsonb_build_object('n', n, 'p',
      case when jsonb_typeof(p) = 'number' then least(1000, greatest(0, round((p #>> '{}')::numeric)::int)) else 0 end));
  end loop;

  v_id := nullif(public.od__txt(p_shop->'id', 40), '');
  if v_id is null then
    v_id := public.od__id(10);
    insert into public.od_shops (id, name, phone, sizes, items, toppings)
    values (v_id, v_name, public.od__txt(p_shop->'phone', 30), v_sizes, v_items, v_tops);
  else
    update public.od_shops set name = v_name, phone = public.od__txt(p_shop->'phone', 30),
      sizes = v_sizes, items = v_items, toppings = v_tops
    where id = v_id;
    if not found then return public.od__fail('找不到這家飲料店，可能已被刪除'); end if;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

create or replace function public.od_shop_delete(p_password text, p_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare e text := public.od__check_admin(p_password);
begin
  if e is not null then return public.od__fail(e, 'admin'); end if;
  delete from public.od_shops where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

-- 儲存整份名單：依順序寫入，清單裡沒有的單位會被刪除
create or replace function public.od_roster_save(p_password text, p_units jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  e text := public.od__check_admin(p_password);
  x jsonb; m jsonb; n text; v_id text; v_members jsonb; v_names text[] := '{}'; i int := 0;
begin
  if e is not null then return public.od__fail(e, 'admin'); end if;
  if coalesce(jsonb_typeof(p_units), '') <> 'array' or jsonb_array_length(p_units) > 200 then return public.od__fail('名單格式錯誤'); end if;
  for x in select * from jsonb_array_elements(p_units) loop
    n := public.od__txt(x->'name', 60);
    if n = '' then return public.od__fail('單位名稱不能空白'); end if;
    if n = any(v_names) then return public.od__fail(format('單位「%s」重複了', n)); end if;
    v_names := v_names || n;
  end loop;
  -- 先刪掉清單裡沒有的單位，再把要保留的單位改成暫時名稱，避免改名互換或同名新增時撞到 unique
  delete from public.od_units
  where id not in (select x->>'id' from jsonb_array_elements(p_units) x where x->>'id' is not null);
  update public.od_units set name = '~' || id where id is not null;
  for x in select * from jsonb_array_elements(p_units) loop
    n := public.od__txt(x->'name', 60);
    v_members := '[]'::jsonb;
    if jsonb_typeof(x->'members') = 'array' then
      for m in select * from jsonb_array_elements(x->'members') loop
        if public.od__txt(m, 40) <> '' and not v_members @> to_jsonb(public.od__txt(m, 40)) and jsonb_array_length(v_members) < 300 then
          v_members := v_members || to_jsonb(public.od__txt(m, 40));
        end if;
      end loop;
    end if;
    v_id := nullif(public.od__txt(x->'id', 40), '');
    if v_id is not null and exists (select 1 from public.od_units where id = v_id) then
      update public.od_units set name = n, members = v_members, ord = i where id = v_id;
    else
      v_id := public.od__id(10);
      insert into public.od_units (id, name, members, ord) values (v_id, n, v_members, i);
    end if;
    i := i + 1;
  end loop;
  return jsonb_build_object('ok', true);
end $$;

-- 只開放這些函式給網頁呼叫
revoke execute on function public.od__id(int) from public, anon, authenticated;
revoke execute on function public.od__participants(jsonb) from public, anon, authenticated;
grant execute on function public.od_order_add(text, jsonb, int) to anon, authenticated;
grant execute on function public.od_order_update(text, jsonb) to anon, authenticated;
grant execute on function public.od_order_delete(text) to anon, authenticated;
grant execute on function public.od_session_create(text, text, jsonb) to anon, authenticated;
grant execute on function public.od_session_set_participants(text, jsonb) to anon, authenticated;
grant execute on function public.od_session_set_status(text, text) to anon, authenticated;
grant execute on function public.od_admin_check(text) to anon, authenticated;
grant execute on function public.od_shop_save(text, jsonb) to anon, authenticated;
grant execute on function public.od_shop_delete(text, text) to anon, authenticated;
grant execute on function public.od_roster_save(text, jsonb) to anon, authenticated;

-- ---------- 即時同步 ----------
do $$
declare t text;
begin
  foreach t in array array['od_shops', 'od_units', 'od_sessions', 'od_orders'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- 6. 設定管理密碼 ----------
-- 把下面的「改成你的管理密碼」換成真正的密碼，選取這一行後再按 Run（只執行這一行）。
-- 之後要換密碼也是同一行。密碼會加密儲存，連資料庫管理者也看不到原文。
--
-- update public.od_admin set pw_hash = extensions.crypt('改成你的管理密碼', extensions.gen_salt('bf')), failed = 0, locked_until = null where id = 1;

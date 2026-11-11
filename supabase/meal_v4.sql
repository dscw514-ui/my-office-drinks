-- V4.0 聚餐模組：只新增 od_meal_*，不修改既有飲料資料表。
-- 先確認原本 supabase/setup.sql 已執行且管理密碼已設定。
create table if not exists public.od_meal_events (
 id uuid primary key default gen_random_uuid(), title text not null check(length(title) between 1 and 100),
 quota integer not null check(quota>=0), adult_price integer not null check(adult_price>=0),
 child_price integer not null check(child_price>=0), height_cm integer not null check(height_cm between 1 and 250),
 status text not null default 'open' check(status in ('open','closed')),
 created_at timestamptz not null default now()
);
create table if not exists public.od_meal_registrations (
 id uuid primary key default gen_random_uuid(), event_id uuid not null references public.od_meal_events(id) on delete cascade,
 unit text not null, name text not null, family_adults integer not null check(family_adults>=0),
 family_children integer not null check(family_children>=0),
 cost integer not null check(cost>=0), note text not null default '', created_at timestamptz not null default now(),
 unique(event_id,unit,name)
);
create table if not exists public.od_meal_allocations (
 id uuid primary key default gen_random_uuid(), event_id uuid not null references public.od_meal_events(id) on delete cascade,
 registration_id uuid not null references public.od_meal_registrations(id) on delete cascade,
 lender_unit text not null, lender_name text not null, amount integer not null check(amount>0),
 unique(event_id,lender_unit,lender_name,registration_id)
);
create index if not exists od_meal_alloc_lender on public.od_meal_allocations(event_id,lender_unit,lender_name);
create table if not exists public.od_meal_audit (
 id bigint generated always as identity primary key, event_id uuid, registration_id uuid,
 action text not null, actor text not null default 'admin', detail jsonb not null default '{}'::jsonb,
 created_at timestamptz not null default now()
);
alter table public.od_meal_events enable row level security;
alter table public.od_meal_registrations enable row level security;
alter table public.od_meal_allocations enable row level security;
alter table public.od_meal_audit enable row level security;
-- 不提供匿名表格直讀（涉及人名、補助）；只由管理密碼驗證的 RPC 讀取。
revoke all on public.od_meal_events, public.od_meal_registrations, public.od_meal_allocations, public.od_meal_audit from anon, authenticated;

create or replace function public.od_meal_manage(p_password text, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare err text; eid uuid; rid uuid; ev public.od_meal_events; r public.od_meal_registrations;
 a jsonb; lender jsonb; u text; n text; v integer; total integer:=0; existing integer; available integer; cost_new integer;
BEGIN
 err:=public.od__check_admin(p_password);
 if err is not null then return jsonb_build_object('ok',false,'error',err); end if;
 if p_action='list' then
  return jsonb_build_object('ok',true,
    'events',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from public.od_meal_events x),'[]'::jsonb),
    'registrations',coalesce((select jsonb_agg(to_jsonb(x)) from public.od_meal_registrations x),'[]'::jsonb),
    'allocations',coalesce((select jsonb_agg(to_jsonb(x)) from public.od_meal_allocations x),'[]'::jsonb));
 elsif p_action='event' then
  if coalesce(length(trim(p_payload->>'title')),0)=0 or length(p_payload->>'title')>100 then raise exception '活動名稱不正確'; end if;
  insert into public.od_meal_events(title,quota,adult_price,child_price,height_cm)
  values(trim(p_payload->>'title'),(p_payload->>'quota')::int,(p_payload->>'adult_price')::int,
         (p_payload->>'child_price')::int,(p_payload->>'height_cm')::int) returning id into eid;
  insert into public.od_meal_audit(event_id,action,detail) values(eid,'create_event',p_payload);
  return jsonb_build_object('ok',true,'id',eid);
 elsif p_action='status' then
  eid:=(p_payload->>'event_id')::uuid;
  update public.od_meal_events set status=p_payload->>'status' where id=eid;
  if not found then raise exception '找不到活動'; end if;
  insert into public.od_meal_audit(event_id,action,detail) values(eid,'set_status',p_payload);
  return jsonb_build_object('ok',true);
 elsif p_action='delete_registration' then
  rid:=(p_payload->>'id')::uuid;
  select * into r from public.od_meal_registrations where id=rid;
  if not found then raise exception '找不到登記'; end if;
  select * into ev from public.od_meal_events where id=r.event_id for update;
  if ev.status<>'open' then raise exception '活動已截止'; end if;
  insert into public.od_meal_audit(event_id,registration_id,action,detail)
    values(r.event_id,rid,'delete_registration',to_jsonb(r));
  delete from public.od_meal_registrations where id=rid;
  return jsonb_build_object('ok',true);
 elsif p_action='registration' then
  eid:=(p_payload->>'event_id')::uuid;
  select * into ev from public.od_meal_events where id=eid for update;
  if not found or ev.status<>'open' then raise exception '活動不存在或已截止'; end if;
  u:=trim(coalesce(p_payload->>'unit','')); n:=trim(coalesce(p_payload->>'name',''));
  if u='' or n='' then raise exception '請選擇登記人'; end if;
  if not exists(select 1 from public.od_units z where z.name=u and z.members ? n) then raise exception '登記人不在現有名單'; end if;
  cost_new:=ev.adult_price*(1+(p_payload->>'family_adults')::int)+ev.child_price*(p_payload->>'family_children')::int;
  if (p_payload->>'family_adults')::int<0 or (p_payload->>'family_children')::int<0 or cost_new<0 then raise exception '人數錯誤'; end if;
  rid:=nullif(p_payload->>'id','')::uuid;
  if rid is not null then
   select * into r from public.od_meal_registrations where id=rid and event_id=eid for update;
   if not found then raise exception '找不到原登記'; end if;
   if r.unit<>u or r.name<>n then raise exception '不能變更原登記人'; end if;
   delete from public.od_meal_allocations where registration_id=rid;
   update public.od_meal_registrations set family_adults=(p_payload->>'family_adults')::int,
     family_children=(p_payload->>'family_children')::int,cost=cost_new,note=left(coalesce(p_payload->>'note',''),500) where id=rid;
  else
   insert into public.od_meal_registrations(event_id,unit,name,family_adults,family_children,cost,note)
   values(eid,u,n,(p_payload->>'family_adults')::int,(p_payload->>'family_children')::int,cost_new,left(coalesce(p_payload->>'note',''),500)) returning id into rid;
  end if;
  if jsonb_typeof(coalesce(p_payload->'allocations','[]'::jsonb))<>'array' then raise exception '額度格式錯誤'; end if;
  for lender in select value from jsonb_array_elements(coalesce(p_payload->'allocations','[]'::jsonb)) loop
   u:=trim(coalesce(lender->>'unit','')); n:=trim(coalesce(lender->>'name','')); v:=(lender->>'amount')::int;
   if v<=0 or u='' or n='' then raise exception '額度來源或金額錯誤'; end if;
   if not exists(select 1 from public.od_units z where z.name=u and z.members ? n) then raise exception '額度提供者不在名單'; end if;
   select coalesce(sum(amount),0) into existing from public.od_meal_allocations where event_id=eid and lender_unit=u and lender_name=n;
   if existing+v>ev.quota then raise exception '同事 % 的剩餘額度不足',n; end if;
   total:=total+v;
   if total>cost_new then raise exception '抵扣額度不可超過總費用'; end if;
   insert into public.od_meal_allocations(event_id,registration_id,lender_unit,lender_name,amount) values(eid,rid,u,n,v);
  end loop;
  insert into public.od_meal_audit(event_id,registration_id,action,detail) values(eid,rid,'save_registration',p_payload);
  return jsonb_build_object('ok',true,'id',rid,'cost',cost_new,'payable',cost_new-total);
 else raise exception '未知操作'; end if;
exception when others then
 return jsonb_build_object('ok',false,'error',sqlerrm);
END $$;
revoke all on function public.od_meal_manage(text,text,jsonb) from public;
grant execute on function public.od_meal_manage(text,text,jsonb) to anon,authenticated;

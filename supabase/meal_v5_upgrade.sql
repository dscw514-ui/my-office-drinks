-- V5 upgrade: run AFTER meal_v4.sql and meal_v41_upgrade.sql.
-- Preserves drink tables and existing meal data.
alter table public.od_meal_restaurants add column if not exists allow_borrow boolean not null default true;
create or replace function public.od_meal_manage(p_password text, p_action text, p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare err text; eid uuid; rid uuid; ev public.od_meal_events; r public.od_meal_registrations;
 a jsonb; lender jsonb; u text; n text; v integer; total integer:=0; existing integer; available integer; cost_new integer;
BEGIN
 err:=public.od__check_admin(p_password);
 if err is not null then return jsonb_build_object('ok',false,'error',err); end if;
 if p_action='list' then
  return jsonb_build_object('ok',true,
    'restaurants',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from public.od_meal_restaurants x),'[]'::jsonb),
    'events',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from public.od_meal_events x),'[]'::jsonb),
    'registrations',coalesce((select jsonb_agg(to_jsonb(x)) from public.od_meal_registrations x),'[]'::jsonb),
    'allocations',coalesce((select jsonb_agg(to_jsonb(x)) from public.od_meal_allocations x),'[]'::jsonb));
 elsif p_action='restaurant' then
  n:=trim(coalesce(p_payload->>'name',''));
  if length(n)<1 or length(n)>100 then raise exception '餐廳名稱不正確'; end if;
  insert into public.od_meal_restaurants(name,adult_price,child_price,height_cm,note,allow_borrow)
  values(n,(p_payload->>'adult_price')::int,(p_payload->>'child_price')::int,(p_payload->>'height_cm')::int,left(coalesce(p_payload->>'note',''),500),coalesce((p_payload->>'allow_borrow')::boolean,true))
  on conflict(name) do update set adult_price=excluded.adult_price,child_price=excluded.child_price,height_cm=excluded.height_cm,note=excluded.note,allow_borrow=excluded.allow_borrow;
  return jsonb_build_object('ok',true);
 elsif p_action='event' then
  if coalesce(length(trim(p_payload->>'title')),0)=0 or length(p_payload->>'title')>100 then raise exception '活動名稱不正確'; end if;
  insert into public.od_meal_events(title,quota,adult_price,child_price,height_cm,restaurant_name)
  values(trim(p_payload->>'title'),(p_payload->>'quota')::int,(p_payload->>'adult_price')::int,
         (p_payload->>'child_price')::int,(p_payload->>'height_cm')::int,left(coalesce(p_payload->>'restaurant_name',''),100)) returning id into eid;
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
  if exists(select 1 from public.od_meal_restaurants x where x.name=ev.restaurant_name and x.allow_borrow=false)
     and exists(select 1 from jsonb_array_elements(coalesce(p_payload->'allocations','[]'::jsonb)) z
                where coalesce(z->>'unit','')<>r.unit or coalesce(z->>'name','')<>r.name)
  then raise exception '此餐廳收費規則禁止借用其他同事額度'; end if;
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

-- 聚餐模組：新增獨立資料表，不修改飲料資料
create table if not exists public.od_meal_restaurants(id text primary key default substr(md5(random()::text),1,16), name text not null, adult_price integer not null check(adult_price>=0), child_price integer not null check(child_price>=0), height_cm integer not null default 140 check(height_cm between 50 and 220), allow_borrow boolean not null default true);
create table if not exists public.od_meal_events(id text primary key default substr(md5(random()::text),1,16), title text not null, restaurant_id text references public.od_meal_restaurants(id), quota integer not null check(quota>=0), status text not null default 'open' check(status in ('open','closed')), created_at timestamptz not null default now());
create table if not exists public.od_meal_registrations(id text primary key default substr(md5(random()::text),1,16), event_id text not null references public.od_meal_events(id) on delete cascade, unit text not null default '', name text not null, adults integer not null check(adults>=1), children integer not null default 0 check(children>=0), gross integer not null check(gross>=0), payable integer not null check(payable>=0), created_at timestamptz not null default now(), unique(event_id,unit,name));
create table if not exists public.od_meal_credits(id bigint generated always as identity primary key, event_id text not null references public.od_meal_events(id) on delete cascade, registration_id text not null references public.od_meal_registrations(id) on delete cascade, lender_unit text not null, lender_name text not null, amount integer not null check(amount>0), unique(registration_id,lender_unit,lender_name));
create index if not exists od_meal_credit_event_idx on public.od_meal_credits(event_id,lender_unit,lender_name);
create index if not exists od_meal_reg_event_idx on public.od_meal_registrations(event_id);
-- RLS: 公開讀取；寫入只能透過 SECURITY DEFINER RPC 且需管理密碼
alter table public.od_meal_restaurants enable row level security;
alter table public.od_meal_events enable row level security;
alter table public.od_meal_registrations enable row level security;
alter table public.od_meal_credits enable row level security;
drop policy if exists od_meal_restaurants_read on public.od_meal_restaurants;
drop policy if exists od_meal_events_read on public.od_meal_events;
drop policy if exists od_meal_registrations_read on public.od_meal_registrations;
drop policy if exists od_meal_credits_read on public.od_meal_credits;
create policy od_meal_restaurants_read on public.od_meal_restaurants for select to anon,authenticated using(true);
create policy od_meal_events_read on public.od_meal_events for select to anon,authenticated using(true);
create policy od_meal_registrations_read on public.od_meal_registrations for select to anon,authenticated using(true);
create policy od_meal_credits_read on public.od_meal_credits for select to anon,authenticated using(true);

create or replace function public.od_meal_save_restaurant(p_password text,p_id text,p_name text,p_adult integer,p_child integer,p_height integer,p_borrow boolean)
returns text language plpgsql security definer set search_path=public as $$
declare k text;
begin
 if public.od__check_admin(p_password) is not null then raise exception '管理密碼不正確'; end if;
 if length(trim(p_name))=0 or p_adult<0 or p_child<0 or p_height not between 50 and 220 then raise exception '餐廳資料無效'; end if;
 k:=coalesce(nullif(p_id,''),substr(md5(random()::text),1,16));
 insert into public.od_meal_restaurants(id,name,adult_price,child_price,height_cm,allow_borrow) values(k,trim(p_name),p_adult,p_child,p_height,coalesce(p_borrow,false)) on conflict(id) do update set name=excluded.name,adult_price=excluded.adult_price,child_price=excluded.child_price,height_cm=excluded.height_cm,allow_borrow=excluded.allow_borrow;
 return k;
end $$;
create or replace function public.od_meal_save_event(p_password text,p_title text,p_restaurant text,p_quota integer)
returns text language plpgsql security definer set search_path=public as $$
declare k text;
begin
 if public.od__check_admin(p_password) is not null then raise exception '管理密碼不正確'; end if;
 if length(trim(p_title))=0 or p_quota<0 or not exists(select 1 from public.od_meal_restaurants where id=p_restaurant) then raise exception '活動資料無效'; end if;
 k:=substr(md5(random()::text),1,16);
 insert into public.od_meal_events(id,title,restaurant_id,quota) values(k,trim(p_title),p_restaurant,p_quota);
 return k;
end $$;
create or replace function public.od_meal_set_status(p_password text,p_event text,p_status text)
returns void language plpgsql security definer set search_path=public as $$
begin
 if public.od__check_admin(p_password) is not null then raise exception '管理密碼不正確'; end if;
 if p_status not in ('open','closed') then raise exception '狀態無效'; end if;
 update public.od_meal_events set status=p_status where id=p_event;
end $$;

-- 每次修改整筆報名與額度分配，在同一交易鎖定活動；失敗則全部回滾。
create or replace function public.od_meal_save_registration(p_password text,p_event text,p_id text,p_unit text,p_name text,p_adults integer,p_children integer,p_lenders jsonb)
returns text language plpgsql security definer set search_path=public as $$
declare e public.od_meal_events; r public.od_meal_restaurants; k text; gross_amount integer; total_credit integer:=0; lender jsonb; lu text; ln text; used_amount integer; borrowed boolean; existing public.od_meal_registrations; member_ok boolean;
begin
 if public.od__check_admin(p_password) is not null then raise exception '管理密碼不正確'; end if;
 select * into e from public.od_meal_events where id=p_event for update;
 if not found or e.status<>'open' then raise exception '活動不存在或已截止'; end if;
 select * into r from public.od_meal_restaurants where id=e.restaurant_id;
 if p_adults<1 or p_children<0 or p_adults+p_children>100 or jsonb_typeof(p_lenders)<>'array' or jsonb_array_length(p_lenders)>100 then raise exception '登記資料無效'; end if;
 if not exists(select 1 from public.od_units u where u.name=p_unit and u.members ? p_name) then raise exception '登記人不在人員名單內'; end if;
 if nullif(p_id,'') is not null then
   select * into existing from public.od_meal_registrations where id=p_id and event_id=p_event;
   if not found then raise exception '找不到原登記'; end if;
 end if;
 k:=coalesce(nullif(p_id,''),substr(md5(random()::text),1,16));
 gross_amount:=p_adults*r.adult_price+p_children*r.child_price;
 -- 刪除舊分配後再重新驗證，避免修改時把自己的舊額度重複計入
 insert into public.od_meal_registrations(id,event_id,unit,name,adults,children,gross,payable)
 values(k,p_event,p_unit,p_name,p_adults,p_children,gross_amount,gross_amount)
 on conflict(id) do update set unit=excluded.unit,name=excluded.name,adults=excluded.adults,children=excluded.children,gross=excluded.gross,payable=excluded.payable;
 delete from public.od_meal_credits where registration_id=k;
 for lender in select value from jsonb_array_elements(p_lenders) loop
   lu:=nullif(trim(lender->>'unit'),''); ln:=nullif(trim(lender->>'name'),'');
   if lu is null or ln is null or not exists(select 1 from public.od_units u where u.name=lu and u.members ? ln) then raise exception '額度提供者不在人員名單內'; end if;
   if not r.allow_borrow and (lu<>p_unit or ln<>p_name) then raise exception '此餐廳不允許借用同事額度'; end if;
   if exists(select 1 from public.od_meal_credits where registration_id=k and lender_unit=lu and lender_name=ln) then raise exception '同一人不可重複選取'; end if;
   select coalesce(sum(amount),0) into used_amount from public.od_meal_credits where event_id=p_event and lender_unit=lu and lender_name=ln;
   if used_amount>0 then raise exception '額度已被使用：%',ln; end if;
   if total_credit+e.quota>gross_amount then raise exception '額度抵扣超過總費用，請減少提供者'; end if;
   insert into public.od_meal_credits(event_id,registration_id,lender_unit,lender_name,amount) values(p_event,k,lu,ln,e.quota);
   total_credit:=total_credit+e.quota;
 end loop;
 update public.od_meal_registrations set payable=gross_amount-total_credit where id=k;
 return k;
end $$;
create or replace function public.od_meal_delete_registration(p_password text,p_event text,p_id text)
returns void language plpgsql security definer set search_path=public as $$
declare e public.od_meal_events;
begin
 if public.od__check_admin(p_password) is not null then raise exception '管理密碼不正確'; end if;
 select * into e from public.od_meal_events where id=p_event for update;
 if not found or e.status<>'open' then raise exception '活動已截止'; end if;
 delete from public.od_meal_registrations where id=p_id and event_id=p_event;
 -- 外鍵 cascade 會同步刪除分配，立即返還額度
end $$;
revoke all on function public.od_meal_save_restaurant(text,text,text,integer,integer,integer,boolean) from public;
revoke all on function public.od_meal_save_event(text,text,text,integer) from public;
revoke all on function public.od_meal_set_status(text,text,text) from public;
revoke all on function public.od_meal_save_registration(text,text,text,text,text,integer,integer,jsonb) from public;
revoke all on function public.od_meal_delete_registration(text,text,text) from public;
grant execute on function public.od_meal_save_restaurant(text,text,text,integer,integer,integer,boolean) to anon,authenticated;
grant execute on function public.od_meal_save_event(text,text,text,integer) to anon,authenticated;
grant execute on function public.od_meal_set_status(text,text,text) to anon,authenticated;
grant execute on function public.od_meal_save_registration(text,text,text,text,text,integer,integer,jsonb) to anon,authenticated;
grant execute on function public.od_meal_delete_registration(text,text,text) to anon,authenticated;

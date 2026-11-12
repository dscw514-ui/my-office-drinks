-- 聚餐收費門檻 V2：先備份資料，再執行；不刪除舊欄位或既有資料。
BEGIN;
ALTER TABLE public.od_meal_restaurants ADD COLUMN IF NOT EXISTS threshold_text text NOT NULL DEFAULT '';
ALTER TABLE public.od_meal_restaurants ADD COLUMN IF NOT EXISTS child_price2 integer NOT NULL DEFAULT 0;
ALTER TABLE public.od_meal_events ADD COLUMN IF NOT EXISTS threshold_text text NOT NULL DEFAULT '';
ALTER TABLE public.od_meal_events ADD COLUMN IF NOT EXISTS child_price2 integer NOT NULL DEFAULT 0;
ALTER TABLE public.od_meal_registrations ADD COLUMN IF NOT EXISTS family_children2 integer NOT NULL DEFAULT 0;
UPDATE public.od_meal_restaurants SET threshold_text=height_cm::text||'cm' WHERE threshold_text='';
UPDATE public.od_meal_events SET threshold_text=height_cm::text||'cm' WHERE threshold_text='';
ALTER TABLE public.od_meal_restaurants DROP CONSTRAINT IF EXISTS od_meal_restaurants_child_price2_check;
ALTER TABLE public.od_meal_restaurants ADD CONSTRAINT od_meal_restaurants_child_price2_check CHECK (child_price2>=0);
ALTER TABLE public.od_meal_events DROP CONSTRAINT IF EXISTS od_meal_events_child_price2_check;
ALTER TABLE public.od_meal_events ADD CONSTRAINT od_meal_events_child_price2_check CHECK (child_price2>=0);
ALTER TABLE public.od_meal_registrations DROP CONSTRAINT IF EXISTS od_meal_registrations_family_children2_check;
ALTER TABLE public.od_meal_registrations ADD CONSTRAINT od_meal_registrations_family_children2_check CHECK (family_children2>=0);

CREATE OR REPLACE FUNCTION public.od_meal_manage(p_password text,p_action text,p_payload jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
 err text; eid uuid; rid uuid; ev public.od_meal_events; r public.od_meal_registrations;
 lender jsonb; lender_unit text; lender_name text; reg_unit text; reg_name text;
 n text; v integer; total integer:=0; existing integer; cost_new integer;
 adults_count integer; child1_count integer; child2_count integer;
BEGIN
 err:=public.od__check_admin(p_password);
 IF err IS NOT NULL THEN RETURN jsonb_build_object('ok',false,'error',err); END IF;
 IF p_action='list' THEN
  RETURN jsonb_build_object('ok',true,
   'restaurants',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.name) FROM public.od_meal_restaurants x),'[]'::jsonb),
   'events',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC) FROM public.od_meal_events x),'[]'::jsonb),
   'registrations',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM public.od_meal_registrations x),'[]'::jsonb),
   'allocations',coalesce((SELECT jsonb_agg(to_jsonb(x)) FROM public.od_meal_allocations x),'[]'::jsonb));
 ELSIF p_action='restaurant' THEN
  n:=trim(coalesce(p_payload->>'name',''));
  IF length(n)<1 OR length(n)>100 THEN RAISE EXCEPTION '餐廳名稱不正確'; END IF;
  INSERT INTO public.od_meal_restaurants(name,adult_price,child_price,child_price2,threshold_text,height_cm,note,allow_borrow)
  VALUES(n,(p_payload->>'adult_price')::integer,(p_payload->>'child_price')::integer,
   coalesce((p_payload->>'child_price2')::integer,0),left(coalesce(p_payload->>'threshold_text',''),200),
   coalesce((p_payload->>'height_cm')::integer,140),left(coalesce(p_payload->>'note',''),500),
   coalesce((p_payload->>'allow_borrow')::boolean,true))
  ON CONFLICT(name) DO UPDATE SET adult_price=excluded.adult_price,child_price=excluded.child_price,
   child_price2=excluded.child_price2,threshold_text=excluded.threshold_text,note=excluded.note,allow_borrow=excluded.allow_borrow;
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='event' THEN
  n:=trim(coalesce(p_payload->>'title',''));
  IF n='' OR length(n)>100 THEN RAISE EXCEPTION '活動名稱不正確'; END IF;
  INSERT INTO public.od_meal_events(title,quota,adult_price,child_price,child_price2,threshold_text,height_cm,restaurant_name)
  VALUES(n,(p_payload->>'quota')::integer,(p_payload->>'adult_price')::integer,
   (p_payload->>'child_price')::integer,coalesce((p_payload->>'child_price2')::integer,0),
   left(coalesce(p_payload->>'threshold_text',''),200),coalesce((p_payload->>'height_cm')::integer,140),
   left(coalesce(p_payload->>'restaurant_name',''),100)) RETURNING id INTO eid;
  INSERT INTO public.od_meal_audit(event_id,action,detail) VALUES(eid,'create_event',p_payload);
  RETURN jsonb_build_object('ok',true,'id',eid);
 ELSIF p_action='status' THEN
  eid:=(p_payload->>'event_id')::uuid;
  UPDATE public.od_meal_events SET status=p_payload->>'status' WHERE id=eid;
  IF NOT FOUND THEN RAISE EXCEPTION '找不到活動'; END IF;
  INSERT INTO public.od_meal_audit(event_id,action,detail) VALUES(eid,'set_status',p_payload);
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='delete_registration' THEN
  rid:=(p_payload->>'id')::uuid;
  SELECT * INTO r FROM public.od_meal_registrations WHERE id=rid;
  IF NOT FOUND THEN RAISE EXCEPTION '找不到登記'; END IF;
  SELECT * INTO ev FROM public.od_meal_events WHERE id=r.event_id FOR UPDATE;
  IF ev.status<>'open' THEN RAISE EXCEPTION '活動已截止'; END IF;
  INSERT INTO public.od_meal_audit(event_id,registration_id,action,detail)
   VALUES(r.event_id,rid,'delete_registration',to_jsonb(r));
  DELETE FROM public.od_meal_allocations WHERE registration_id=rid;
  DELETE FROM public.od_meal_registrations WHERE id=rid;
  RETURN jsonb_build_object('ok',true);
 ELSIF p_action='registration' THEN
  eid:=(p_payload->>'event_id')::uuid;
  SELECT * INTO ev FROM public.od_meal_events WHERE id=eid FOR UPDATE;
  IF NOT FOUND OR ev.status<>'open' THEN RAISE EXCEPTION '活動不存在或已截止'; END IF;
  reg_unit:=trim(coalesce(p_payload->>'unit',''));reg_name:=trim(coalesce(p_payload->>'name',''));
  IF reg_unit='' OR reg_name='' THEN RAISE EXCEPTION '請選擇登記人'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.od_units z WHERE z.name=reg_unit AND z.members ? reg_name) THEN RAISE EXCEPTION '登記人不在現有名單'; END IF;
  adults_count:=coalesce((p_payload->>'family_adults')::integer,0);
  child1_count:=coalesce((p_payload->>'family_children')::integer,0);
  child2_count:=coalesce((p_payload->>'family_children2')::integer,0);
  IF adults_count<0 OR child1_count<0 OR child2_count<0 THEN RAISE EXCEPTION '人數錯誤'; END IF;
  cost_new:=ev.adult_price*(1+adults_count)+ev.child_price*child1_count+ev.child_price2*child2_count;
  IF cost_new<0 THEN RAISE EXCEPTION '費用錯誤'; END IF;
  IF jsonb_typeof(coalesce(p_payload->'allocations','[]'::jsonb))<>'array' THEN RAISE EXCEPTION '額度格式錯誤'; END IF;
  rid:=nullif(p_payload->>'id','')::uuid;
  IF rid IS NOT NULL THEN
   SELECT * INTO r FROM public.od_meal_registrations WHERE id=rid AND event_id=eid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION '找不到原登記'; END IF;
   IF r.unit<>reg_unit OR r.name<>reg_name THEN RAISE EXCEPTION '不能變更原登記人'; END IF;
   DELETE FROM public.od_meal_allocations WHERE registration_id=rid;
   UPDATE public.od_meal_registrations SET family_adults=adults_count,family_children=child1_count,
    family_children2=child2_count,cost=cost_new,note=left(coalesce(p_payload->>'note',''),500) WHERE id=rid;
  ELSE
   INSERT INTO public.od_meal_registrations(event_id,unit,name,family_adults,family_children,family_children2,cost,note)
   VALUES(eid,reg_unit,reg_name,adults_count,child1_count,child2_count,cost_new,left(coalesce(p_payload->>'note',''),500)) RETURNING id INTO rid;
  END IF;
  FOR lender IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'allocations','[]'::jsonb)) LOOP
   lender_unit:=trim(coalesce(lender->>'unit',''));lender_name:=trim(coalesce(lender->>'name',''));
   v:=(lender->>'amount')::integer;
   IF v IS NULL OR v<=0 OR lender_unit='' OR lender_name='' THEN RAISE EXCEPTION '額度來源或金額錯誤'; END IF;
   IF NOT EXISTS(SELECT 1 FROM public.od_units z WHERE z.name=lender_unit AND z.members ? lender_name) THEN RAISE EXCEPTION '額度提供者不在名單'; END IF;
   IF EXISTS(SELECT 1 FROM public.od_meal_restaurants x WHERE x.name=ev.restaurant_name AND x.allow_borrow=false)
     AND (lender_unit<>reg_unit OR lender_name<>reg_name) THEN RAISE EXCEPTION '此餐廳禁止借用其他同事額度'; END IF;
   SELECT coalesce(sum(a.amount),0) INTO existing FROM public.od_meal_allocations a
    WHERE a.event_id=eid AND a.lender_unit=lender_unit AND a.lender_name=lender_name;
   IF existing+v>ev.quota THEN RAISE EXCEPTION '同事 % 的剩餘額度不足',lender_name; END IF;
   total:=total+v;
   IF total>cost_new THEN RAISE EXCEPTION '抵扣額度不可超過總費用'; END IF;
   INSERT INTO public.od_meal_allocations(event_id,registration_id,lender_unit,lender_name,amount)
    VALUES(eid,rid,lender_unit,lender_name,v);
  END LOOP;
  INSERT INTO public.od_meal_audit(event_id,registration_id,action,detail) VALUES(eid,rid,'save_registration',p_payload);
  RETURN jsonb_build_object('ok',true,'id',rid,'cost',cost_new,'payable',cost_new-total);
 ELSE RAISE EXCEPTION '未知操作'; END IF;
EXCEPTION WHEN OTHERS THEN
 RETURN jsonb_build_object('ok',false,'error',sqlerrm);
END $function$;
COMMIT;

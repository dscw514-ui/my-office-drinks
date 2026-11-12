import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
const root=document.getElementById('meal-app');
const state={tab:'order',data:null,event:'',edit:'',person:'',unit:'',adults:1,children:0,children2:0,lenders:[],pw:sessionStorage.getItem('meal-admin')||'',error:'',notice:'',restaurant:'',formRestaurant:'',title:'',quota:1000};
const h=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=n=>'NT$'+Number(n||0).toLocaleString('en-US');
let sb;
const members=()=>state.data?.units.flatMap(u=>(u.members||[]).map(name=>({unit:u.name,name})))||[];
const event=()=>state.data?.events.find(x=>x.id===state.event);
const restaurant=()=>state.data?.restaurants.find(x=>x.name===event()?.restaurant_name);
const regs=()=>state.data?.regs.filter(x=>x.event_id===state.event)||[];
const credits=()=>state.data?.credits.filter(x=>x.event_id===state.event)||[];
const selectedPerson=()=>members().find(p=>p.unit+'|'+p.name===state.person);
const total=()=>state.adults*(event()?.adult_price||0)+state.children*(event()?.child_price||0)+state.children2*(event()?.child_price2||0);
const opts=(list,value,label)=>list.map(x=>`<option value="${h(value(x))}">${h(label(x))}</option>`).join('');
function show(){
 const e=event(),r=restaurant(),g=regs(),c=credits();
 root.innerHTML=`<header class="meal-head"><div><h1>🍽️ 聚餐管理</h1><span class="meal-muted">Office Hub · 與飲料系統共用人員名單</span></div><div class="meal-tools"><a href="index.html">🧋 飲料訂購</a><button class="secondary" data-action="password">🔐 ${state.pw?'管理者已設定':'管理者密碼'}</button></div></header>
 ${state.error?`<p class="meal-error">${h(state.error)}</p>`:''}${state.notice?`<p class="meal-ok">${h(state.notice)}</p>`:''}
 <section class="meal-box"><div class="meal-grid"><div class="meal-field"><label>選擇聚餐團</label><select id="event"><option value="">請選擇活動</option>${opts(state.data?.events||[],x=>x.id,x=>`${x.title}（${x.status==='open'?'開放':'截止'}）`)}</select></div><div class="meal-tools">${state.pw?'<button data-action="newEvent">＋ 開新團</button>':''}${state.pw?`<button class="secondary" data-action="status" ${!e?'disabled':''}>`:'<span style="display:none">'}${e?.status==='open'?'結束登記':'重新開放'}</button><button class="secondary" data-action="reload">重新整理</button></div></div></section>
 <nav class="tabs">${[['order','訂購'],['summary','彙總'],['menu','菜單'],['roster','名單']].map(([k,t])=>`<button class="tab ${state.tab===k?'on':''}" data-action="tab" data-value="${k}">${t}</button>`).join('')}</nav>
 <main class="pane">${state.tab==='order'?viewOrder(e,r,g,c):state.tab==='summary'?viewSummary(g,c):state.tab==='menu'?viewMenu():viewRoster()}</main>`;
 const ev=document.getElementById('event');if(ev)ev.value=state.event;
 const per=document.getElementById('person');if(per)per.value=state.person;
 document.querySelectorAll('[data-lender]').forEach(x=>x.checked=state.lenders.includes(x.dataset.lender));
 const rid=document.getElementById('restaurant');if(rid)rid.value=state.restaurant;
}
function viewOrder(e,r,g,c){if(!e)return '<section class="meal-box">請先選擇或建立聚餐團。</section>';
 const people=members(),own=selectedPerson(),cost=total(),discount=Math.min(cost,state.lenders.length*e.quota),remaining=cost-discount;
 return `<section class="meal-box"><h2>${h(e.title)}</h2><p class="meal-muted">${h(r?.name)}｜成人 ${money(e?.adult_price)}｜未達門檻1 ${money(e?.child_price)}｜未達門檻2 ${money(e?.child_price2)}｜門檻1說明 ${h(e?.threshold1_text||e?.threshold_text||`${e?.height_cm} cm`)}｜門檻2說明 ${h(e?.threshold2_text||"未設定")}｜每位員工額度 ${money(e.quota)}</p><div class="meal-grid">
 <div class="meal-field"><label>登記人員</label><select id="person"><option value="">選擇姓名</option>${opts(people,p=>p.unit+'|'+p.name,p=>p.unit+' / '+p.name)}</select></div>
 <div class="meal-field"><label>成人／達身高門檻人數（含本人）</label><input id="adults" type="number" min="1" max="100" value="${state.adults}"></div>
 <div class="meal-field"><label>未達門檻1人數</label><input id="children" type="number" min="0" max="100" value="${state.children}"></div><div class="meal-field"><label>未達門檻2人數</label><input id="children2" type="number" min="0" max="100" value="${state.children2}"></div></div>
 <h3>使用本人或其他同事額度（未參加也可以提供）</h3><p class="meal-muted">每位同事在同一活動只能提供一次額度；需要先取得同事同意。已使用額度者無法再選。</p>
 <div class="meal-lenders">${people.map(p=>{const key=p.unit+'|'+p.name;const used=c.some(x=>x.lender_unit===p.unit&&x.lender_name===p.name&&x.registration_id!==state.edit);const isOwn=key===state.person;return `<label><input type="checkbox" data-lender="${h(key)}" ${(used||(!r?.allow_borrow&&!isOwn))?'disabled':''}> ${h(p.unit)}／${h(p.name)} ${used?'（額度已使用）':''}${isOwn?'（本人）':''}</label>`}).join('')}</div>
 <div class="meal-line"><span>原始總費用</span><strong>${money(cost)}</strong></div><div class="meal-line"><span>額度抵扣</span><strong>${money(discount)}</strong></div><div class="meal-line"><span>實際應付</span><strong class="meal-stat">${money(Math.max(0,remaining))}</strong></div>
 <div class="meal-tools"><button data-action="save" ${e.status!=='open'||!own||remaining<0?'disabled':''}>${state.edit?'儲存修改':'送出登記'}</button><button class="secondary" data-action="reset">清除／取消修改</button></div></section>`;
}
function viewSummary(g,c){if(!event())return '<section class="meal-box">請先選擇聚餐團。</section>';
 const gross=g.reduce((a,x)=>a+x.cost,0),pay=gross-c.reduce((a,x)=>a+x.amount,0);
 return `<section class="meal-box"><h2>聚餐彙總</h2><div class="meal-grid"><div>參加人數<div class="meal-stat">${g.reduce((a,x)=>a+1+x.family_adults+x.family_children+(x.family_children2||0),0)}</div></div><div>原始總費用<div class="meal-stat">${money(gross)}</div></div><div>已抵扣額度<div class="meal-stat">${money(gross-pay)}</div></div><div>實際應收<div class="meal-stat">${money(pay)}</div></div></div><div class="meal-tools"><button data-action="export">匯出 CSV</button></div><div class="meal-scroll"><table class="meal-table"><thead><tr><th>登記人</th><th>成人</th><th>門檻1</th><th>門檻2</th><th>原始金額</th><th>額度來源</th><th>應付</th><th>操作</th></tr></thead><tbody>${g.map(x=>`<tr><td>${h(x.unit)}／${h(x.name)}</td><td>${1+x.family_adults}</td><td>${x.family_children}</td><td>${x.family_children2||0}</td><td>${money(x.cost)}</td><td>${h(c.filter(y=>y.registration_id===x.id).map(y=>y.lender_name).join('、'))}</td><td>${money((x.cost-c.filter(y=>y.registration_id===x.id).reduce((sum,y)=>sum+y.amount,0)))}</td><td><div class="meal-tools"><button data-action="edit" data-id="${h(x.id)}">修改</button><button data-action="delete" data-id="${h(x.id)}">刪除</button></div></td></tr>`).join('')}</tbody></table></div></section>`;
}
function viewMenu(){const rr=state.data?.restaurants||[];return `<section class="meal-box"><h2>餐廳菜單／收費規則</h2><p class="meal-muted">門檻1、門檻2可分別輸入中文、英文或數字，例如：120–140cm、未滿6歲、Under 120 cm。</p>${state.pw?`<div class="meal-grid"><div class="meal-field"><label>餐廳名稱</label><input id="rname" placeholder="餐廳名稱"></div><div class="meal-field"><label>成人／達門檻費用</label><input id="radult" type="number" min="0" value="1000"></div><div class="meal-field"><label>未達門檻1費用</label><input id="rchild" type="number" min="0" value="500"></div><div class="meal-field"><label>未達門檻2費用</label><input id="rchild2" type="number" min="0" value="0"></div><div class="meal-field"><label>門檻1說明（中／英文）</label><input id="rthreshold1" type="text" maxlength="200" placeholder="例：120–140cm"><div class="meal-field"><label>門檻2說明（中／英文）</label><input id="rthreshold2" type="text" maxlength="200" placeholder="例：未滿120cm"></div></div></div><p><label><input id="rborrow" type="checkbox" checked> 允許借用未參加聚餐同事的額度</label></p><div class="meal-tools"><button data-action="saveRestaurant">${state.formRestaurant?'儲存修改':'新增餐廳'}</button><button class="secondary" data-action="cancelRestaurant">取消編輯</button></div>`:'<p class="meal-muted">菜單僅管理者可以編輯或刪除。</p>'}<div class="meal-scroll"><table class="meal-table"><thead><tr><th>餐廳</th><th>成人</th><th>門檻1</th><th>門檻2</th><th>門檻1說明</th><th>門檻2說明</th><th>借用額度</th><th>操作</th></tr></thead><tbody>${rr.map(x=>`<tr><td>${h(x.name)}</td><td>${money(x.adult_price)}</td><td>${money(x.child_price)}</td><td>${money(x.child_price2)}</td><td>${h(x.threshold1_text||x.threshold_text||`${x.height_cm}cm`)}</td><td>${h(x.threshold2_text||"未設定")}</td><td>${x.allow_borrow?'允許':'不允許'}</td><td>${state.pw?`<button class="btn sm" data-action="editRestaurant" data-id="${h(x.id)}">編輯</button><button class="btn sm" data-action="deleteRestaurant" data-id="${h(x.id)}">刪除</button>`:'僅管理者'}</td></tr>`).join('')}</tbody></table></div></section>`}
function viewRoster(){return `<section class="meal-box"><h2>共用人員名單</h2><p>名單直接讀取飲料系統的 <code>od_units</code>，要新增或修改請至飲料系統「名單」分頁。</p>${(state.data?.units||[]).map(u=>`<div class="meal-line"><strong>${h(u.name)}</strong><span>${h((u.members||[]).join('、'))}</span></div>`).join('')}<div class="meal-tools"><a href="index.html">前往飲料系統管理名單</a></div></section>`}
async function load(){
 try {
  
  const [unitsResult, mealResult]=await Promise.all([
   sb.from('od_units').select('*').order('ord'),
   sb.rpc('od_meal_public',{p_action:'list',p_payload:{}})
  ]);
  if(unitsResult.error)throw unitsResult.error;
  if(mealResult.error)throw mealResult.error;
  if(!mealResult.data?.ok)throw Error(mealResult.data?.error||'聚餐資料載入失敗');
  const d=mealResult.data;
  state.data={units:unitsResult.data||[],restaurants:d.restaurants||[],events:(d.events||[]).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),regs:d.registrations||[],credits:d.allocations||[]};
  if(!event())state.event=state.data.events[0]?.id||'';
  state.error='';show();
 }catch(e){state.error=e.message||String(e);show()}
}
async function rpc(action,payload){
 const isPublic=['registration','delete_registration'].includes(action);
 if(!isPublic&&!state.pw)throw Error('此操作需要管理者密碼');
 const {data,error}=await sb.rpc(isPublic?'od_meal_public':'od_meal_manage',isPublic?{p_action:action,p_payload:payload}:{p_password:state.pw,p_action:action,p_payload:payload});
 if(error)throw error;
 if(!data?.ok)throw Error(data?.error||'操作失敗');
 return data;
}
async function execute(fn){try{state.error='';state.notice='';await fn();await load();state.notice='操作成功';show()}catch(e){state.error=e.message||String(e);show()}}
function reset(){state.edit='';state.person='';state.adults=1;state.children=0;state.children2=0;state.lenders=[];show()}
function csv(){
 const rows=[['單位','登記人','成人','門檻1','門檻2','原始金額','額度來源','抵扣金額','應付金額'],...regs().map(x=>{
  const allocations=credits().filter(y=>y.registration_id===x.id),discount=allocations.reduce((sum,y)=>sum+y.amount,0);
  return [x.unit,x.name,1+x.family_adults,x.family_children,x.family_children2||0,x.cost,allocations.map(y=>y.lender_name).join('、'),discount,x.cost-discount];
 })];
 const content='\\ufeff'+rows.map(row=>row.map(v=>'"'+String(v??'').replaceAll('"','""')+'"').join(',')).join('\\r\\n');
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'}));a.download='聚餐彙總.csv';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
root.addEventListener('change',ev=>{const t=ev.target;if(t.id==='event'){state.event=t.value;reset()}if(t.id==='person'){state.person=t.value;state.lenders=[];show()}if(t.id==='adults'||t.id==='children'||t.id==='children2'){state[t.id]=Math.max(t.id==='adults'?1:0,Number(t.value)||0);show()}if(t.dataset.lender){state.lenders=t.checked?[...state.lenders,t.dataset.lender]:state.lenders.filter(x=>x!==t.dataset.lender);show()}});
root.addEventListener('click',async ev=>{const b=ev.target.closest('[data-action]');if(!b)return;const a=b.dataset.action;
 if(a==='tab'){state.tab=b.dataset.value;show();return}if(a==='reload'){await load();return}if(a==='reset'){reset();return}if(a==='export'){csv();return}
 if(a==='password'){const p=prompt('輸入飲料系統管理者密碼（留空可登出管理者）','');if(p!==null){if(p){const {data,error}=await sb.rpc('od_meal_manage',{p_password:p,p_action:'list',p_payload:{}});if(error||!data?.ok){alert(data?.error||error?.message||'管理者密碼錯誤');return}}state.pw=p;sessionStorage.setItem('meal-admin',p);await load()}return}
 if(a==='newEvent'){if(!state.data.restaurants.length){state.tab='menu';state.error='請先在菜單建立餐廳';show();return}const title=prompt('聚餐團名稱');if(!title)return;const rest=prompt('請輸入餐廳編號：\n'+state.data.restaurants.map((x,i)=>`${i+1}. ${x.name}`).join('\n'),'1');const restaurant=state.data.restaurants[Number(rest)-1];if(!restaurant)return;const quota=Number(prompt('每位員工本場補助額度（元）','1000'));if(!Number.isInteger(quota)||quota<0)return;await execute(async()=>{state.event=(await rpc('event',{title,restaurant_name:restaurant.name,adult_price:restaurant.adult_price,child_price:restaurant.child_price,child_price2:restaurant.child_price2||0,threshold1_text:restaurant.threshold1_text||restaurant.threshold_text||"",threshold2_text:restaurant.threshold2_text||"",height_cm:restaurant.height_cm,quota})).id});return}
 if(a==='status'){if(!event())return;await execute(()=>rpc('status',{event_id:state.event,status:event().status==='open'?'closed':'open'}));return}
 if(a==='cancelRestaurant'){state.formRestaurant='';show();return}
 if(a==='deleteRestaurant'){if(!state.pw)return alert('請先登入管理者');if(!confirm('確定刪除此餐廳菜單？已有活動紀錄的餐廳無法刪除。'))return;await execute(()=>rpc('delete_restaurant',{id:b.dataset.id}));return}
 if(a==='saveRestaurant'){const name=document.getElementById('rname').value.trim(),adult=Number(document.getElementById('radult').value),child=Number(document.getElementById('rchild').value),child2=Number(document.getElementById('rchild2').value),threshold1=document.getElementById('rthreshold1').value.trim(),threshold2=document.getElementById('rthreshold2').value.trim(),borrow=document.getElementById('rborrow').checked;if(!name)return alert('請輸入餐廳名稱');if(![adult,child,child2].every(x=>Number.isSafeInteger(x)&&x>=0))return alert('費用必須是非負整數');await execute(async()=>{await rpc('restaurant',{id:state.formRestaurant||null,name,adult_price:adult,child_price:child,child_price2:child2,threshold1_text:threshold1,threshold2_text:threshold2,allow_borrow:borrow});state.formRestaurant='' });return}
 if(a==='editRestaurant'){const r=state.data.restaurants.find(x=>x.id===b.dataset.id);if(!r)return;state.formRestaurant=r.id;document.getElementById('rname').value=r.name;document.getElementById('radult').value=r.adult_price;document.getElementById('rchild').value=r.child_price;document.getElementById('rchild2').value=r.child_price2||0;document.getElementById('rthreshold1').value=r.threshold1_text||r.threshold_text||`${r.height_cm}cm`;document.getElementById('rthreshold2').value=r.threshold2_text||'';document.getElementById('rborrow').checked=r.allow_borrow;return}
 if(a==='save'){const p=selectedPerson();if(!p)return;const cost=total();const quota=event()?.quota||0;let left=cost;const allocations=state.lenders.map(x=>{const [unit,name]=x.split('|');const amount=Math.min(left,quota);left-=amount;return{unit,name,amount}}).filter(x=>x.amount>0);await execute(async()=>{await rpc('registration',{event_id:state.event,id:state.edit||null,unit:p.unit,name:p.name,family_adults:state.adults-1,family_children:state.children,family_children2:state.children2,allocations});state.edit='';state.lenders=[]});return}
 if(a==='edit'){const x=regs().find(y=>y.id===b.dataset.id);if(!x)return;state.edit=x.id;state.person=x.unit+'|'+x.name;state.adults=1+x.family_adults;state.children=x.family_children;state.children2=x.family_children2||0;state.lenders=credits().filter(y=>y.registration_id===x.id).map(y=>y.lender_unit+'|'+y.lender_name);state.tab='order';show();return}
 if(a==='delete'){if(!confirm('確定刪除此筆登記並返還所有額度？'))return;await execute(()=>rpc('delete_registration',{id:b.dataset.id}));return}
});
(async()=>{try{const {createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');sb=createClient(SUPABASE_URL,SUPABASE_ANON_KEY);await load()}catch(e){state.error='初始化失敗：'+e.message;show()}})();

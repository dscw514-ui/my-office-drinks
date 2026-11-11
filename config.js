// Supabase 專案設定（與桌球系統共用同一個專案，本系統資料表以 od_ 開頭）。
// 這兩個值本來就是公開的；真正的安全由資料庫規則（supabase/setup.sql）把關。
// 注意：千萬不要貼上 service_role / secret key。
export const SUPABASE_URL = 'https://ykjtgldwddimdqrtdhhj.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_pHvLU8F9ICceh6UaBCz_vg_3INoDhFN';
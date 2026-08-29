import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// 接続情報は環境変数から読む(コードに直書きしない)。
// 未設定でも UI はプレビューできるよう、supabase は null を許容する。
// 接続は AppMap の「接続」欄が .env(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)に書き込む。
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** URL と anon key が両方そろっていれば接続済み。 */
export const isSupabaseConnected = Boolean(url && anonKey);

/** Supabase クライアント。未接続なら null(UI は「未接続」表示でプレビュー可)。 */
export const supabase: SupabaseClient | null = isSupabaseConnected
  ? createClient(url!, anonKey!)
  : null;

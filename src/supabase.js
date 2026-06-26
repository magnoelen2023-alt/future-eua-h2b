import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://vqgelehnxfubzdueiapl.supabase.co'
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_OfsSzDZDY_kvSYNidQJANw_tqJYrfXu'

export const supabase = createClient(supabaseUrl, supabaseKey)
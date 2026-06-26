import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://vqgelehnxfubzdueiapl.supabase.co'
const supabaseKey = 'sb_publishable_OfsSzDZDY_kvSYNidQJANw_tqJYrfXu'

export const supabase = createClient(supabaseUrl, supabaseKey)
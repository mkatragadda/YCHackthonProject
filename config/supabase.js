import { createClient } from '@supabase/supabase-js';

// Helper function to check if Supabase is configured
export const isSupabaseConfigured = () => {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return !!(supabaseUrl && supabaseAnonKey &&
    supabaseUrl !== 'your_supabase_project_url' &&
    supabaseAnonKey !== 'your_supabase_anon_key' &&
    supabaseUrl.startsWith('http'));
};

// Lazy initialization of supabase client
let _supabase = null;

// Create a single supabase client for interacting with your database
// Only initialize if properly configured, otherwise use null
export const getSupabase = () => {
  if (_supabase) return _supabase;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (isSupabaseConfigured()) {
    _supabase = createClient(supabaseUrl, supabaseAnonKey);
  } else {
    _supabase = null;
  }

  return _supabase;
};

// Export supabase as a getter for backwards compatibility
export const supabase = new Proxy({}, {
  get: (_target, prop) => {
    const client = getSupabase();
    if (!client) return null;
    return client[prop];
  }
});

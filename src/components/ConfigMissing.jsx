import React from 'react';
import { AlertCircle } from 'lucide-react';

export default function ConfigMissing() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--paper)' }}>
      <div className="max-w-xl w-full rounded-xl border p-8" style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
        <div className="flex items-center gap-3 mb-4" style={{ color: 'var(--clay)' }}>
          <AlertCircle className="w-6 h-6" />
          <div className="serif text-2xl" style={{ fontWeight: 500 }}>Configuration missing</div>
        </div>

        <p className="text-sm opacity-80 mb-5 leading-relaxed">
          Leave Desk needs your Supabase credentials to start. Set the two environment variables below and restart the app.
        </p>

        <div className="rounded-lg p-4 mono text-xs whitespace-pre-wrap" style={{ background: 'var(--evergreen-900)', color: '#E3EDE5' }}>
{`VITE_SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
VITE_SUPABASE_ANON_KEY=ey...your anon key...`}
        </div>

        <div className="mt-6 space-y-3 text-sm opacity-80">
          <p><span style={{ fontWeight: 500 }}>Local development:</span> copy <span className="mono">.env.example</span> to <span className="mono">.env.local</span> and fill in values, then run <span className="mono">npm run dev</span>.</p>
          <p><span style={{ fontWeight: 500 }}>Netlify:</span> add both variables in Site settings → Environment variables, then redeploy.</p>
        </div>

        <div className="mt-6 p-4 rounded-lg text-xs" style={{ background: 'var(--evergreen-50)', color: 'var(--evergreen-700)' }}>
          Find your credentials in the Supabase dashboard under <strong>Project Settings → API</strong>. Use the <strong>anon public</strong> key, not the service-role key.
        </div>
      </div>
    </div>
  );
}

// 1) Create a Supabase project.
// 2) Run supabase-setup.sql in its SQL Editor.
// 3) Paste the Project URL and PUBLISHABLE key below.
// The publishable key is designed for browser apps. Never paste a secret key here.
window.WHP_CONFIG = {
  supabaseUrl: 'https://vnawxioukgfofzaxygfb.supabase.co',
  supabasePublishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuYXd4aW91a2dmb2Z6YXh5Z2ZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNzE5NTQsImV4cCI6MjEwMDg0Nzk1NH0.E9JNzZhFaaS_1B0IKyRKe7MM1Pm3gIW4kyqmrDyLkrw',
  defaultSessionCode: 'TEAM-RETRO'
};

// Capture participant-private RPC metadata before online.js processes it.
// The backend intentionally keeps assignments outside the shared state in some
// responses; fixes.js merges only the current participant's assignment back in.
(() => {
  const originalFetch = window.fetch.bind(window);
  window.__whpOriginalFetch = originalFetch;
  window.__whpPrivatePayload = null;

  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const url = String(args?.[0]?.url || args?.[0] || '');
    if (/\/rest\/v1\/rpc\/(whp_join|whp_get_state|whp_participant_action)(?:\?|$)/i.test(url)) {
      response.clone().json().then(payload => {
        window.__whpPrivatePayload = payload;
        window.dispatchEvent(new CustomEvent('whp:private-payload', {
          detail: { payload, url }
        }));
      }).catch(() => {});
    }
    return response;
  };

  const loadFixes = () => {
    if (document.querySelector('script[data-whp-fixes]')) return;
    const script = document.createElement('script');
    script.src = './fixes.js?v=20260802-1';
    script.async = false;
    script.dataset.whpFixes = 'true';
    document.head.appendChild(script);
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', loadFixes, { once: true });
  } else {
    loadFixes();
  }
})();

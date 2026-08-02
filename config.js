// 1) Create a Supabase project.
// 2) Run supabase-setup.sql in its SQL Editor.
// 3) Paste the Project URL and PUBLISHABLE key below.
// The publishable key is designed for browser apps. Never paste a secret key here.
window.WHP_CONFIG = {
  supabaseUrl: 'https://vnawxioukgfofzaxygfb.supabase.co',
  supabasePublishableKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuYXd4aW91a2dmb2Z6YXh5Z2ZiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNzE5NTQsImV4cCI6MjEwMDg0Nzk1NH0.E9JNzZhFaaS_1B0IKyRKe7MM1Pm3gIW4kyqmrDyLkrw',
  defaultSessionCode: 'TEAM-RETRO'
};

// Keep participant-private assignment metadata available to fixes.js, and force
// the Shared Screen to request public/shared data even when this browser also
// contains a participant or facilitator login.
(() => {
  const originalFetch = window.fetch.bind(window);
  window.__whpOriginalFetch = originalFetch;
  window.__whpPrivatePayload = null;

  const isSharedContext = () => {
    const query = new URLSearchParams(window.location.search);
    return query.get('view') === 'shared' ||
      window.location.hash === '#shared' ||
      document.getElementById('screen-shared')?.classList.contains('active');
  };

  window.fetch = async (...inputArgs) => {
    let args = [...inputArgs];
    const requestUrl = String(args?.[0]?.url || args?.[0] || '');

    if (/\/rest\/v1\/rpc\/whp_get_state(?:\?|$)/i.test(requestUrl) && isSharedContext()) {
      const originalInit = args[1] || {};
      try {
        const body = typeof originalInit.body === 'string'
          ? JSON.parse(originalInit.body)
          : { ...(originalInit.body || {}) };
        body.p_mode = 'shared';
        body.p_token = null;
        body.p_pin = null;
        args[1] = { ...originalInit, body: JSON.stringify(body) };
      } catch (_) {
        // Leave the original request untouched if its body is not JSON.
      }
    }

    const response = await originalFetch(...args);
    const finalUrl = String(args?.[0]?.url || args?.[0] || '');
    if (/\/rest\/v1\/rpc\/(whp_join|whp_get_state|whp_participant_action)(?:\?|$)/i.test(finalUrl)) {
      response.clone().json().then(payload => {
        window.__whpPrivatePayload = payload;
        window.dispatchEvent(new CustomEvent('whp:private-payload', {
          detail: { payload, url: finalUrl }
        }));
      }).catch(() => {});
    }
    return response;
  };

  const appendScript = src => new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src^="${src.split('?')[0]}"]`);
    if (existing) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });

  const loadFixes = async () => {
    try {
      await appendScript('./fixes.js?v=20260802-3');
      await appendScript('./shared-results-fix.js?v=20260802-3');
    } catch (error) {
      console.error('Unable to load Team Retro fixes', error);
    }
  };

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', loadFixes, { once: true });
  } else {
    loadFixes();
  }
})();

/* Live multi-device adapter for Web of High Performance.
   The original UI remains intact; this file replaces browser-only persistence
   with controlled Supabase RPC calls and realtime update notifications. */

(() => {
  const cfg = window.WHP_CONFIG || {};
  const rawSupabaseUrl = String(cfg.supabaseUrl || '').trim();
  const normalisedSupabaseUrl = rawSupabaseUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
  const params = new URLSearchParams(window.location.search);
  const configured = Boolean(
    normalisedSupabaseUrl &&
    cfg.supabasePublishableKey &&
    !normalisedSupabaseUrl.includes('PASTE_') &&
    !String(cfg.supabasePublishableKey).includes('PASTE_')
  );
  const sessionCode = String(params.get('session') || cfg.defaultSessionCode || 'TEAM-RETRO')
    .toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const tokenKey = `whpParticipantToken:${sessionCode}`;
  const participantIdKey = `whpParticipantId:${sessionCode}`;
  const pinKey = `whpFacilitatorPin:${sessionCode}`;

  let db = null;
  let participantToken = localStorage.getItem(tokenKey) || '';
  let facilitatorPin = sessionStorage.getItem(pinKey) || '';
  let lastSyncedState = null;
  let realtimeChannel = null;
  let saveQueue = Promise.resolve();
  let saveCount = 0;
  let refreshTimer = null;
  let refreshAfterSave = false;
  let sessionExists = false;
  let appInitialised = false;
  // Debounce rendering from rapid polling/realtime.
  let renderPending = false;
  let renderTimer = null;
  // Track focus + caret across rerenders to avoid interrupting input.
  let lastActiveFocusId = null;
  let lastActiveCaretStart = null;
  let lastActiveCaretEnd = null;

  const activeScreen = name => document.getElementById(`screen-${name}`)?.classList.contains('active');
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  const copy = value => JSON.parse(JSON.stringify(value));

  function errorText(error) {
    const raw = String(error?.message || error?.details || error || 'Unknown error');
    const known = [
      'SESSION_NOT_FOUND','INCORRECT_PIN','NAME_NOT_FOUND','INVALID_PARTICIPANT_TOKEN',
      'SESSION_ALREADY_EXISTS','SESSION_CODE_TOO_SHORT','PIN_TOO_SHORT','ACTIVITY_NOT_OPEN',
      'ASSIGNMENT_NOT_READY','ALREADY_SUBMITTED','AVATAR_ALREADY_TAKEN','AVATAR_REQUIRED',
      'COMPLIMENT_TOO_SHORT','PROBLEM_TOO_SHORT','RESPONSIBILITY_TOO_SHORT','INVALID_VOTE_COUNT','UNKNOWN_ACTION'
    ];
    return known.find(k => raw.includes(k)) || raw;
  }

  function friendlyError(error) {
    const code = errorText(error);
    return ({
      SESSION_NOT_FOUND:'The live session has not been created yet.',
      INCORRECT_PIN:'Incorrect facilitator PIN.',
      NAME_NOT_FOUND:'Name not recognised. Enter the exact name added by the facilitator.',
      INVALID_PARTICIPANT_TOKEN:'Your private login expired. Please enter your name again.',
      SESSION_ALREADY_EXISTS:'That session already exists.',
      SESSION_CODE_TOO_SHORT:'Use a session code with at least four characters.',
      PIN_TOO_SHORT:'Use a facilitator PIN with at least four characters.',
      ACTIVITY_NOT_OPEN:'This activity is not open right now.',
      ASSIGNMENT_NOT_READY:'Your shout-out assignment is not ready yet.',
      ALREADY_SUBMITTED:'You have already submitted this activity.',
      AVATAR_ALREADY_TAKEN:'That avatar was just selected by someone else. Choose another.',
      AVATAR_REQUIRED:'Choose an avatar first.',
      COMPLIMENT_TOO_SHORT:'Please write a more specific compliment.',
      PROBLEM_TOO_SHORT:'Add a clear title and specific details.',
      RESPONSIBILITY_TOO_SHORT:'Write a specific personal behaviour.',
      INVALID_VOTE_COUNT:'Choose no more topics than the allowed vote limit.',
      UNKNOWN_ACTION:'The app sent an unsupported action.'
    })[code] || (/PGRST202|404|Could not find the function/i.test(code)
      ? 'Backend functions were not found. Run supabase-setup.sql in the same Supabase project, then refresh the schema and redeploy.'
      : `Online error: ${code}`);
  }

  function setOnlineStatus(text, tone='green') {
    const el = document.getElementById('autosave-status');
    if (!el) return;
    el.textContent = text;
    el.className = `pill ${tone}`;
  }

  function liveParticipantUrl() {
    const url = new URL(window.location.href);
    url.hash = '';
    url.search = '';
    url.searchParams.set('session', sessionCode);
    return url.toString();
  }

  function liveSharedUrl() {
    const url = new URL(liveParticipantUrl());
    url.searchParams.set('view','shared');
    return url.toString();
  }

  async function copyLiveLink(kind='participant') {
    const value = kind === 'shared' ? liveSharedUrl() : liveParticipantUrl();
    try {
      await navigator.clipboard.writeText(value);
      toast(kind === 'shared' ? 'Shared-screen link copied' : 'Participant link copied');
    } catch {
      window.prompt('Copy this link:', value);
    }
  }

  function showConfigurationHelp() {
    const home = document.querySelector('#screen-home .hero');
    if (!home || document.getElementById('online-config-warning')) return;
    const warning = document.createElement('div');
    warning.id = 'online-config-warning';
    warning.className = 'panel';
    warning.style.gridColumn = '1 / -1';
    warning.innerHTML = `
      <h3>Online setup is not finished</h3>
      <p class="panel-sub">Open <strong>config.js</strong>, paste your Supabase Project URL and publishable key, then deploy this entire folder. The secret key must never be placed in the browser.</p>
      <span class="pill yellow">Session code: ${esc(sessionCode)}</span>`;
    home.appendChild(warning);
  }

  function sessionMode() {
    if (facilitatorUnlocked && facilitatorPin) return 'facilitator';
    if (participantToken && currentParticipantId) return 'participant';
    return 'shared';
  }

  async function rpc(name,args) {
    if (!configured) throw new Error('ONLINE_NOT_CONFIGURED');
    const endpoint = `${normalisedSupabaseUrl}/rest/v1/rpc/${encodeURIComponent(name)}`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          apikey: String(cfg.supabasePublishableKey).trim(),
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify(args || {})
      });
    } catch (networkError) {
      throw new Error(`NETWORK_ERROR: ${networkError?.message || networkError}`);
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = text; }
    }
    if (!response.ok) {
      const detail = typeof payload === 'string'
        ? payload
        : (payload?.message || payload?.details || payload?.hint || JSON.stringify(payload));
      const error = new Error(detail || `HTTP_${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function captureFocusForRerender() {
    try {
      const ae = document.activeElement;
      if (ae && ae.id && typeof ae.selectionStart === 'number') {
        lastActiveFocusId = ae.id;
        lastActiveCaretStart = ae.selectionStart;
        lastActiveCaretEnd = ae.selectionEnd;
      } else if (ae && ae.id) {
        lastActiveFocusId = ae.id;
        lastActiveCaretStart = null;
        lastActiveCaretEnd = null;
      } else {
        lastActiveFocusId = null;
      }
    } catch (_) { lastActiveFocusId = null; }
  }

  function restoreFocusAfterRerender() {
    if (!lastActiveFocusId) return;
    try {
      const el = document.getElementById(lastActiveFocusId);
      if (!el) return;
      el.focus({ preventScroll: true });
      if (typeof el.selectionStart === 'number' && lastActiveCaretStart != null) {
        try {
          el.selectionStart = Math.min(lastActiveCaretStart, (el.value||'').length);
          el.selectionEnd = Math.min(lastActiveCaretEnd ?? el.selectionStart, (el.value||'').length);
        } catch (_) {}
      }
    } catch (_) {}
  }

  function participantViewSignature(sourceState, participantId) {
    if (!sourceState || !participantId) return '';
    const participants = sourceState.participants || [];
    const participant = participants.find(p => p.id === participantId) || {};
    const phase = sourceState.settings?.phase || 'closed';
    const recipientId = sourceState.assignments?.[participantId] || null;
    const recipient = participants.find(p => p.id === recipientId) || {};
    const own = item => (item?.participantId || item?.clientParticipantId || item?.authorId) === participantId;
    const signature = {
      phase,
      labels: sourceState.settings?.labels || {},
      avatarId: participant.avatarId || null,
      recipientId,
      recipientName: recipient.name || null,
      recipientAvatarId: recipient.avatarId || null,
      shoutoutDone: (sourceState.shoutouts || []).some(own),
      scanDone: (sourceState.scanResponses || []).some(own),
      voteDone: (sourceState.votes || []).some(own),
      responsibilityDone: (sourceState.responsibilities || []).some(own)
    };
    if (phase === 'scan') signature.categories = sourceState.categories || [];
    if (phase === 'voting') {
      signature.problems = (sourceState.problems || []).map(p => ({id:p.id,title:p.title,details:p.details,categoryId:p.categoryId}));
      signature.voteLimit = sourceState.settings?.voteLimit || 3;
    }
    if (phase === 'problems') signature.categories = sourceState.categories || [];
    return JSON.stringify(signature);
  }

  function applyIncomingState(payload, mode) {
    if (!payload?.state) return;
    const previousState = state;
    const previousSignature = participantViewSignature(previousState,currentParticipantId);
    const previousAssignment = currentParticipantId ? previousState?.assignments?.[currentParticipantId] : null;

    state = migrateState(payload.state);
    sessionExists = true;
    if (mode === 'facilitator') lastSyncedState = copy(state);
    if (payload.participant_id) {
      currentParticipantId = payload.participant_id;
      localStorage.setItem(participantIdKey,currentParticipantId);
    }

    const newAssignment = currentParticipantId ? state?.assignments?.[currentParticipantId] : null;
    if (previousAssignment && newAssignment !== previousAssignment && window.resetWheelLocalState) {
      resetWheelLocalState();
    }

    updateHome();

    // Only rebuild the currently visible screen when its meaningful server data changed.
    // In particular, never refocus or rebuild the participant login on each polling tick.
    if (facilitatorUnlocked && activeScreen('facilitator')) {
      captureFocusForRerender();
      scheduleRenderCurrentScreen(50);
    } else if (activeScreen('shared')) {
      scheduleRenderCurrentScreen(50);
    } else if (currentParticipantId && activeScreen('participant-hub')) {
      const nextSignature = participantViewSignature(state,currentParticipantId);
      if (previousSignature !== nextSignature) {
        captureFocusForRerender();
        scheduleRenderCurrentScreen(50);
      }
    }
  }

  function scheduleRenderCurrentScreen(delay=120) {
    renderPending = true;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      renderPending = false;
      renderCurrentScreen();
      restoreFocusAfterRerender();
    }, delay);
  }

  function renderCurrentScreen() {
    if (facilitatorUnlocked && activeScreen('facilitator')) renderFacilitator();
    if (currentParticipantId && activeScreen('participant-hub')) renderParticipantHub();
    if (activeScreen('shared')) renderShared();
  }

  async function refreshState(explicitMode=null, silent=false) {
    if (!configured || !db) return;
    if (saveCount > 0 && !explicitMode) {
      refreshAfterSave = true;
      return;
    }
    const mode = explicitMode || sessionMode();
    const args = {
      p_code: sessionCode,
      p_mode: mode,
      p_token: mode === 'participant' ? participantToken : null,
      p_pin: mode === 'facilitator' ? facilitatorPin : null
    };
    try {
      const payload = await rpc('whp_get_state',args);
      applyIncomingState(payload,mode);
      if (mode === 'facilitator') setOnlineStatus('Live and saved','green');
    } catch (error) {
      const code = errorText(error);
      if (code === 'SESSION_NOT_FOUND') {
        sessionExists = false;
        document.getElementById('home-session-title').textContent = 'Live session not created yet';
        if (activeScreen('shared')) {
          document.getElementById('shared-content').innerHTML = '<div class="panel"><div class="empty">The facilitator has not created this live session yet.</div></div>';
        }
        return;
      }
      if (code === 'INVALID_PARTICIPANT_TOKEN') {
        participantToken = '';
        currentParticipantId = null;
        localStorage.removeItem(tokenKey);
        localStorage.removeItem(participantIdKey);
        if (!silent) toast('Private login expired. Please join again.');
        showScreen('participant-login');
        return;
      }
      if (!silent) toast(friendlyError(error));
      console.error(error);
    }
  }

  function scheduleRefresh(delay=120) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshState(),delay);
  }

  function subscribeRealtime() {
    if (!configured || !db || realtimeChannel) return;
    realtimeChannel = db
      .channel(`whp-session-${sessionCode}`)
      .on('postgres_changes',{
        event:'*', schema:'public', table:'whp_session_events',
        filter:`session_code=eq.${sessionCode}`
      },() => scheduleRefresh())
      .subscribe();
  }

  function diffObject(oldObj,newObj,path,ops) {
    const oldVal = oldObj ?? {};
    const newVal = newObj ?? {};
    const keys = new Set([...Object.keys(oldVal),...Object.keys(newVal)]);
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key;
      if (nextPath === 'settings.pin') continue;
      if (!(key in newVal)) {
        ops.push({kind:'delete_path',path:nextPath});
        continue;
      }
      const a = oldVal[key], b = newVal[key];
      const bothPlain = a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b);
      if (bothPlain) diffObject(a,b,nextPath,ops);
      else if (!same(a,b)) ops.push({kind:'set_path',path:nextPath,value:b});
    }
  }

  function diffArrayById(collection,oldArr,newArr,ops) {
    const oldMap = new Map((oldArr||[]).map(item=>[item.id,item]));
    const newMap = new Map((newArr||[]).map(item=>[item.id,item]));
    for (const [id,item] of newMap) {
      if (!oldMap.has(id) || !same(oldMap.get(id),item)) {
        ops.push({kind:'upsert_item',collection,item});
      }
    }
    for (const id of oldMap.keys()) {
      if (!newMap.has(id)) ops.push({kind:'delete_item',collection,id});
    }
  }

  function diffStates(oldState,newState) {
    const ops=[];
    diffObject(oldState?.settings||{},newState?.settings||{},'settings',ops);
    diffObject(oldState?.ui||{},newState?.ui||{},'ui',ops);
    diffObject(oldState?.assignments||{},newState?.assignments||{},'assignments',ops);
    const collections=['participants','categories','scanResponses','shoutouts','problems','votes','repairs','missions','results','responsibilities'];
    collections.forEach(name=>diffArrayById(name,oldState?.[name]||[],newState?.[name]||[],ops));
    if (!same(oldState?.revealedShoutouts||[],newState?.revealedShoutouts||[])) {
      ops.push({kind:'replace_top',collection:'revealedShoutouts',value:newState.revealedShoutouts||[]});
    }
    return ops;
  }

  async function pushFacilitatorOps(ops) {
    if (!ops.length) return;
    saveCount += 1;
    setOnlineStatus('Saving online…','yellow');
    try {
      await rpc('whp_facilitator_patch',{
        p_code:sessionCode,
        p_pin:facilitatorPin,
        p_ops:ops
      });
      setOnlineStatus('Live and saved','green');
    } catch (error) {
      setOnlineStatus('Sync error','red');
      toast(friendlyError(error));
      console.error(error);
      await refreshState('facilitator',true);
    } finally {
      saveCount -= 1;
      if (saveCount === 0 && refreshAfterSave) {
        refreshAfterSave = false;
        scheduleRefresh(20);
      }
    }
  }

  // Replace browser-only autosave with record-level online patches.
  saveState = window.saveState = function saveStateOnline() {
    updateHome();
    if (facilitatorUnlocked) renderFacilitator();
    if (activeScreen('shared')) renderShared();
    if (!facilitatorUnlocked || !facilitatorPin || !lastSyncedState) return;
    const ops = diffStates(lastSyncedState,state);
    if (!ops.length) return;
    lastSyncedState = copy(state); // optimistic baseline for rapid consecutive edits
    saveQueue = saveQueue.then(()=>pushFacilitatorOps(ops));
  };

  const originalRenderSetupTab = renderSetupTab;
  renderSetupTab = window.renderSetupTab = function renderLiveSetupTab() {
    originalRenderSetupTab();
    const tab = document.getElementById('tab-setup');
    if (!tab) return;
    tab.querySelectorAll('.panel-sub').forEach(p=>{
      if (p.textContent.includes('saves automatically in this browser')) p.textContent='Changes save to the live session and appear on every connected laptop.';
    });
    tab.querySelectorAll('.field').forEach(field=>{
      const label = field.querySelector('label');
      if (label?.textContent.trim()==='Facilitator PIN') {
        field.innerHTML='<label>Facilitator PIN</label><div class="pill green">Protected by the PIN used to create this session</div><div class="hint">The PIN is not included in participant links or browser-visible session data.</div>';
      }
    });
    tab.insertAdjacentHTML('afterbegin',`
      <div class="panel" id="live-session-panel">
        <div class="toolbar">
          <div><h3 style="margin:0">Live Multi-device Session</h3><p class="panel-sub">Everyone opens the same participant link and answers simultaneously from their own laptop.</p></div>
          <span class="pill green right">Session ${esc(sessionCode)}</span>
        </div>
        <div class="field"><label>Participant link</label><input readonly value="${esc(liveParticipantUrl())}" onclick="this.select()"></div>
        <div class="toolbar"><button class="btn-primary" onclick="copyLiveLink('participant')">Copy Participant Link</button><button class="btn-secondary" onclick="copyLiveLink('shared')">Copy Shared-screen Link</button><button class="btn-dark" onclick="openSharedWindow()">Open Shared Screen</button></div>
        <div class="hint" style="margin-top:12px">Add all participant names and prepare shout-out assignments before sending the link.</div>
      </div>`);
  };

  const originalRenderDataTab = renderDataTab;
  renderDataTab = window.renderDataTab = function renderLiveDataTab() {
    originalRenderDataTab();
    const tab=document.getElementById('tab-data');
    if (!tab) return;
    tab.querySelectorAll('.panel-sub').forEach(p=>{
      p.textContent=p.textContent
        .replace('The current session already persists in this browser through local storage.','The live session is stored online. JSON export remains available as an extra backup.')
        .replace('This permanently clears the locally saved session unless you export it first.','This clears the live session for every connected participant. Export a backup first if needed.');
    });
  };

  const originalRenderFacilitator = renderFacilitator;
  renderFacilitator = window.renderFacilitator = function renderLiveFacilitator() {
    originalRenderFacilitator();
    setOnlineStatus(saveCount ? 'Saving online…' : 'Live and saved', saveCount ? 'yellow' : 'green');
  };

  openFacilitatorLogin = window.openFacilitatorLogin = function openLiveFacilitatorLogin() {
    if (!configured) return toast('Complete config.js before using the live app.');
    if (facilitatorUnlocked) return showScreen('facilitator');
    document.getElementById('facilitator-pin-input').value='';
    document.getElementById('facilitator-login-dialog').showModal();
    setTimeout(()=>document.getElementById('facilitator-pin-input').focus(),50);
  };

  facilitatorLogin = window.facilitatorLogin = async function facilitatorLiveLogin() {
    if (!configured) return toast('Complete config.js first.');
    const pin=document.getElementById('facilitator-pin-input').value;
    if (pin.length<4) return toast('Use a PIN with at least four characters.');
    try {
      let payload;
      try {
        payload=await rpc('whp_facilitator_login',{p_code:sessionCode,p_pin:pin});
      } catch (error) {
        if (errorText(error)!=='SESSION_NOT_FOUND') throw error;
        const initial=newState();
        initial.settings.pin='';
        payload=await rpc('whp_create_session',{p_code:sessionCode,p_pin:pin,p_state:initial});
        toast('Live session created');
      }
      facilitatorPin=pin;
      sessionStorage.setItem(pinKey,pin);
      facilitatorUnlocked=true;
      closeDialog('facilitator-login-dialog');
      applyIncomingState(payload,'facilitator');
      subscribeRealtime();
      showScreen('facilitator');
    } catch (error) {
      toast(friendlyError(error));
    }
  };

  lockFacilitator = window.lockFacilitator = function lockLiveFacilitator() {
    facilitatorUnlocked=false;
    facilitatorPin='';
    sessionStorage.removeItem(pinKey);
    showScreen('home');
    toast('Facilitator dashboard locked');
    refreshState('shared',true);
  };

  enterParticipantFlow = window.enterParticipantFlow = async function enterLiveParticipantFlow() {
    if (!configured) return toast('This live app has not been configured yet.');
    if (participantToken && currentParticipantId) {
      await refreshState('participant',true);
      const p=getParticipant(currentParticipantId);
      if (!p) { participantLogout(); return; }
      if (!p.avatarId) { renderAvatarSelection(); showScreen('avatar'); }
      else { renderParticipantHub(); showScreen('participant-hub'); }
      return;
    }
    showScreen('participant-login');
    const input=document.getElementById('participant-name-input');
    if(input){
      if(localUI.participantNameTyping) input.value=localUI.participantNameTyping;
      requestAnimationFrame(()=>{ try{ input.focus({preventScroll:true}); }catch(_){ input.focus(); } });
    }
  };

  participantLogin = window.participantLogin = async function participantLiveLogin() {
    if (localUI.participantLoginPending) return;
    const input=document.getElementById('participant-name-input');
    const button=document.getElementById('participant-login-button');
    const name=(input?.value || localUI.participantNameTyping || '').trim();
    localUI.participantNameTyping=name;
    if (!name) return toast('Enter your name.');
    localUI.participantLoginPending=true;
    if(button){ button.disabled=true; button.textContent='Joining…'; }
    try {
      const payload=await rpc('whp_join',{p_code:sessionCode,p_name:name});
      participantToken=payload.token;
      currentParticipantId=payload.participant_id;
      localStorage.setItem(tokenKey,participantToken);
      localStorage.setItem(participantIdKey,currentParticipantId);
      if(window.resetWheelLocalState) resetWheelLocalState();
      applyIncomingState(payload,'participant');
      subscribeRealtime();
      const p=getParticipant(currentParticipantId);
      if (!p?.avatarId) { renderAvatarSelection(); showScreen('avatar'); }
      else { renderParticipantHub(); showScreen('participant-hub'); }
    } catch (error) {
      toast(friendlyError(error));
      if(input){ input.value=localUI.participantNameTyping; requestAnimationFrame(()=>{ try{input.focus({preventScroll:true})}catch(_){input.focus()} }); }
    } finally {
      localUI.participantLoginPending=false;
      if(button){ button.disabled=false; button.textContent='Continue'; }
    }
  };

  participantLogout = window.participantLogout = function participantLiveLogout() {
    participantToken='';
    currentParticipantId=null;
    localStorage.removeItem(tokenKey);
    localStorage.removeItem(participantIdKey);
    if(window.resetParticipantLocalState) resetParticipantLocalState();
    localUI.participantNameTyping='';
    const input=document.getElementById('participant-name-input'); if(input) input.value='';
    showScreen('home');
    refreshState('shared',true);
  };

  async function participantAction(action,payload) {
    if (!participantToken) return toast('Join the session again.');
    try {
      const data=await rpc('whp_participant_action',{
        p_code:sessionCode,
        p_token:participantToken,
        p_action:action,
        p_payload:payload||{}
      });
      applyIncomingState(data,'participant');
      return true;
    } catch (error) {
      toast(friendlyError(error));
      return false;
    }
  }

  saveParticipantAvatar = window.saveParticipantAvatar = async function saveLiveAvatar() {
    if (!selectedAvatarId) return;
    const ok=await participantAction('set_avatar',{avatarId:selectedAvatarId});
    if (ok) { renderParticipantHub(); showScreen('participant-hub'); toast('Avatar secured'); }
  };

  submitShoutout = window.submitShoutout = async function submitLiveShoutout(_recipientIdParam) {
    if (window.submitGuard && !window.submitGuard()) return;
    try {
      const text=document.getElementById('shoutout-text')?.value.trim()||'';
      if (text.length<12) { if(window.submitDone) window.submitDone(); return toast('Please write a specific compliment'); }
      const recipientId = _recipientIdParam || (currentParticipantId ? (state.assignments||{})[currentParticipantId] : null);
      if (!recipientId) { if(window.submitDone) window.submitDone(); return toast('Assignment not ready yet.'); }
      const ok=await participantAction('submit_shoutout',{id:uid(),text,recipientId});
      if (ok) {
        if (window.localUI) localUI.draftShoutout = '';
        renderParticipantHub();
        toast('Shout-out submitted');
      }
    } finally { if(window.submitDone) window.submitDone(); }
  };

  submitScan = window.submitScan = async function submitLiveScan() {
    if (window.submitGuard && !window.submitGuard()) return;
    try {
      const answers={};
      for (const c of state.categories) {
        const score=Number(document.getElementById('score-'+c.id)?.value);
        const reason=document.getElementById('reason-'+c.id)?.value.trim()||'';
        if (!score||!reason) { if(window.submitDone) window.submitDone(); return toast(`Complete the score and reason for ${c.name}`); }
        answers[c.id]={score,reason};
      }
      const ok=await participantAction('submit_scan',{id:uid(),answers});
      if (ok) {
        if (window.localUI) { localUI.draftReasons={}; localUI.scoreSelections={}; }
        renderParticipantHub();
        toast('Team scan submitted');
      }
    } finally { if(window.submitDone) window.submitDone(); }
  };

  submitProblem = window.submitProblem = async function submitLiveProblem() {
    if (window.submitGuard && !window.submitGuard()) return;
    try {
      const title=document.getElementById('problem-title')?.value.trim()||'';
      const details=document.getElementById('problem-details')?.value.trim()||'';
      const categoryId=document.getElementById('problem-category')?.value||'';
      if (title.length<4||details.length<12) { if(window.submitDone) window.submitDone(); return toast('Add a clear title and specific details'); }
      const ok=await participantAction('submit_problem',{id:uid(),title,details,categoryId});
      if (ok) {
        if (window.localUI) localUI.draftProblem = { title:'', details:'', categoryId:'' };
        renderParticipantHub();
        toast('Broken web added anonymously');
      }
    } finally { if(window.submitDone) window.submitDone(); }
  };

  submitVotes = window.submitVotes = async function submitLiveVotes() {
    if (window.submitGuard && !window.submitGuard()) return;
    try {
      const problemIds=[...document.querySelectorAll('.vote-check:checked')].map(x=>x.value);
      if (!problemIds.length) { if(window.submitDone) window.submitDone(); return toast('Choose at least one topic'); }
      if (problemIds.length > (state.settings?.voteLimit||3)) { if(window.submitDone) window.submitDone(); return toast(`Choose at most ${state.settings?.voteLimit||3} topics`); }
      const ok=await participantAction('submit_votes',{id:uid(),problemIds});
      if (ok) {
        if (window.localUI) localUI.draftVoteSelection = [];
        renderParticipantHub();
        toast('Votes submitted');
      }
    } finally { if(window.submitDone) window.submitDone(); }
  };

  submitResponsibility = window.submitResponsibility = async function submitLiveResponsibility() {
    if (window.submitGuard && !window.submitGuard()) return;
    try {
      const text=document.getElementById('responsibility-text')?.value.trim()||'';
      if (text.length<8) { if(window.submitDone) window.submitDone(); return toast('Write a specific personal behaviour'); }
      const ok=await participantAction('submit_responsibility',{id:uid(),text});
      if (ok) {
        if (window.localUI) localUI.draftResponsibility = '';
        renderParticipantHub();
        toast('Responsibility added');
      }
    } finally { if(window.submitDone) window.submitDone(); }
  };

  resetSession = window.resetSession = async function resetLiveSession() {
    if (!(await askConfirm('Reset the entire live session?','This clears responses for every connected laptop. Export first if needed.','Reset'))) return;
    state=newState();
    state.settings.pin='';
    saveState();
    toast('Live session reset');
    showScreen('facilitator');
  };

  openSharedWindow = window.openSharedWindow = function openLiveSharedWindow() {
    window.open(liveSharedUrl(),'whpSharedScreen','noopener');
  };

  sharedStageNav = window.sharedStageNav = function liveSharedStageNav() {
    if (!facilitatorUnlocked || params.get('view')==='shared') return '';
    return `<div class="shared-nav no-print">${['overview','shoutouts','scan','problems','voting','missions','responsibility'].map(v=>`<button class="${state.ui.sharedView===v?'btn-primary':'btn-dark'} btn-small" onclick="setSharedView('${v}')">${sharedViewLabel(v)}</button>`).join('')}</div>`;
  };

  setSharedView = window.setSharedView = function setLiveSharedView(v) {
    if (!facilitatorUnlocked) return;
    state.ui.sharedView=v;
    saveState();
  };

  window.copyLiveLink = copyLiveLink;

  async function initialise() {
    if (appInitialised) return;
    appInitialised=true;

    document.title='Web of High Performance — Live';
    const brandSub=document.querySelector('.brand p');
    if (brandSub) brandSub.textContent='Live multi-device retrospective';
    const hint=document.querySelector('#facilitator-login-dialog .hint');
    if (hint) hint.textContent='For a new session, the first PIN you enter becomes the facilitator PIN.';
    const loginHint=document.querySelector('#screen-participant-login .hint');
    if (loginHint) loginHint.textContent='Names never appear on the shared screen. Your private answers are returned only to you and the protected facilitator dashboard.';

    currentParticipantId=localStorage.getItem(participantIdKey)||null;

    if (!configured || !window.supabase?.createClient) {
      showConfigurationHelp();
      return;
    }

    db=window.supabase.createClient(normalisedSupabaseUrl,cfg.supabasePublishableKey,{
      auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}
    });
    subscribeRealtime();
    // Reliable fallback: refresh every two seconds even if Realtime is blocked
    // by a work network or by differences between Supabase API-key formats.
    window.setInterval(() => {
      if (configured && document.visibilityState === 'visible') scheduleRefresh(20);
    }, 2000);

    const isSharedWindow=params.get('view')==='shared' || window.location.hash==='#shared';
    if (isSharedWindow) {
      document.body.classList.add('shared-window');
      const header=document.querySelector('header');
      if (header) header.style.display='none';
      await refreshState('shared',true);
      showScreen('shared');
    } else if (participantToken && currentParticipantId) {
      await refreshState('participant',true);
    } else {
      await refreshState('shared',true);
    }

    if (window.location.protocol==='file:') {
      toast('Deploy this folder online before sharing it with the team.');
    }
  }

  // Override the old cross-tab localStorage listener by keeping online state authoritative.
  window.addEventListener('focus',()=>{ if (configured) scheduleRefresh(20); });
  initialise();
})();

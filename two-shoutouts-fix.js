/* Team Retro: optional one-or-two shout-out assignments.
   - Facilitators can assign one or two recipients to each participant.
   - A recipient may be assigned to multiple different writers.
   - A writer cannot be assigned themselves or the same recipient twice.
   - Participants write a separate private shout-out for every assigned person.
   - Existing single-recipient assignments remain supported.
*/
(() => {
  'use strict';

  const cfg = window.WHP_CONFIG || {};
  const supabaseUrl = String(cfg.supabaseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
  const params = new URLSearchParams(window.location.search);
  const sessionCode = String(params.get('session') || cfg.defaultSessionCode || 'TEAM-RETRO')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  const tokenKey = `whpParticipantToken:${sessionCode}`;
  const participantIdKey = `whpParticipantId:${sessionCode}`;

  const wheelState = window.__whpTwoShoutoutWheel || {
    key: '',
    spun: false,
    revealed: false,
    formVisible: false,
    finalAngle: null,
    endsAt: 0,
    timerId: null
  };
  window.__whpTwoShoutoutWheel = wheelState;

  const drafts = window.__whpTwoShoutoutDrafts || {};
  window.__whpTwoShoutoutDrafts = drafts;

  const isShoutoutTextarea = element => Boolean(
    element &&
    element.matches?.('textarea[id^="shoutout-text-"], textarea#shoutout-text')
  );

  function participantIsTypingShoutout() {
    return Boolean(
      state?.settings?.phase === 'shoutouts' &&
      isShoutoutTextarea(document.activeElement)
    );
  }

  function normaliseAssignment(value) {
    const raw = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    const result = [];
    for (const item of raw) {
      const id = String(item || '').trim();
      if (id && !result.includes(id)) result.push(id);
      if (result.length === 2) break;
    }
    return result;
  }

  function ownShoutouts(participantId) {
    return (Array.isArray(state?.shoutouts) ? state.shoutouts : []).filter(item =>
      String(item?.authorId || item?.clientParticipantId || '') === String(participantId || '')
    );
  }

  function countSettings() {
    state.settings = state.settings || {};
    state.settings.shoutoutCounts = state.settings.shoutoutCounts || {};
    return state.settings.shoutoutCounts;
  }

  function requiredCount(authorId) {
    const assignments = normaliseAssignment(state?.assignments?.[authorId]);
    const configured = Number(countSettings()[authorId]);
    if (configured === 2) return 2;
    if (configured === 1) return 1;
    return assignments.length > 1 ? 2 : 1;
  }

  function assignmentIds(authorId) {
    const count = requiredCount(authorId);
    return normaliseAssignment(state?.assignments?.[authorId])
      .filter(id => id !== String(authorId))
      .slice(0, count);
  }

  function validRecipientIds(authorId) {
    const participantIds = new Set((state?.participants || []).map(person => String(person.id)));
    return assignmentIds(authorId).filter(id => participantIds.has(id));
  }

  function pendingRecipientIds(authorId) {
    const completed = new Set(ownShoutouts(authorId).map(item => String(item.recipientId || '')));
    return validRecipientIds(authorId).filter(id => !completed.has(id));
  }

  function currentParticipant() {
    if (typeof currentParticipantId === 'undefined' || !currentParticipantId) return null;
    return typeof getParticipant === 'function' ? getParticipant(currentParticipantId) : null;
  }

  function currentPendingKey() {
    const participant = currentParticipant();
    return participant ? pendingRecipientIds(participant.id).join('|') : '';
  }

  function clearWheelState() {
    if (wheelState.timerId) clearTimeout(wheelState.timerId);
    wheelState.key = '';
    wheelState.spun = false;
    wheelState.revealed = false;
    wheelState.formVisible = false;
    wheelState.finalAngle = null;
    wheelState.endsAt = 0;
    wheelState.timerId = null;
  }

  function guardedResetWheel(force = false) {
    const activeKey = currentPendingKey();
    if (!force && wheelState.key && wheelState.key === activeKey) return;
    clearWheelState();
    if (window.localUI) {
      localUI.wheelSpun = false;
      localUI.wheelResultVisible = false;
      localUI.wheelFormVisible = false;
      localUI.wheelRecipientId = null;
      localUI.wheelFinalAngle = null;
    }
  }

  function ensureStateShape() {
    if (typeof state === 'undefined' || !state) return;
    state.assignments = state.assignments || {};
    const counts = countSettings();
    for (const participant of state.participants || []) {
      const authorId = String(participant.id);
      const raw = normaliseAssignment(state.assignments[authorId])
        .filter(id => id !== authorId);
      const count = Number(counts[authorId]) === 2 || raw.length > 1 ? 2 : 1;
      counts[authorId] = count;
      if (raw.length) state.assignments[authorId] = raw.slice(0, count);
      else delete state.assignments[authorId];
    }
  }

  function optionMarkup(authorId, selectedId, otherSelectedId) {
    return (state.participants || [])
      .filter(person => String(person.id) !== String(authorId))
      .map(person => {
        const id = String(person.id);
        const selected = id === selectedId ? ' selected' : '';
        const disabled = id === otherSelectedId && id !== selectedId ? ' disabled' : '';
        return `<option value="${id}"${selected}${disabled}>${esc(person.name)}</option>`;
      })
      .join('');
  }

  function assignmentStatus(authorId) {
    const required = requiredCount(authorId);
    const assigned = validRecipientIds(authorId).length;
    const submitted = ownShoutouts(authorId)
      .filter(item => validRecipientIds(authorId).includes(String(item.recipientId || '')))
      .length;
    if (assigned < required) return `<span class="pill yellow">${assigned}/${required} assigned</span>`;
    if (submitted >= required) return `<span class="pill green">${submitted}/${required} submitted</span>`;
    if (submitted > 0) return `<span class="pill yellow">${submitted}/${required} submitted</span>`;
    return '<span class="pill green">Ready</span>';
  }

  function renderAssignmentsWithTwoSlots() {
    ensureStateShape();
    const tab = document.getElementById('tab-assignments');
    if (!tab) return;

    const requiredTotal = (state.participants || []).reduce((sum, participant) => sum + requiredCount(participant.id), 0);
    const assignedTotal = (state.participants || []).reduce((sum, participant) => sum + validRecipientIds(participant.id).length, 0);

    tab.innerHTML = `
      <div class="panel">
        <h3>Prepare Shout-out Assignments</h3>
        <p class="panel-sub">Choose whether each participant writes for one person or two people. The same receiver may be assigned to several different writers.</p>
        <div class="toolbar">
          <button class="btn-secondary" onclick="fillRandomAssignments()">Randomly Fill Missing Slots</button>
          <button class="btn-dark" onclick="clearAssignments()">Clear Assignments</button>
          <span class="pill ${assignedTotal === requiredTotal && requiredTotal ? 'green' : 'yellow'}">${assignedTotal}/${requiredTotal} slots ready</span>
        </div>
      </div>
      <div class="panel">
        ${(state.participants || []).length < 2
          ? '<div class="empty">Add at least two participants.</div>'
          : `<div class="table-wrap"><table><thead><tr><th>Participant</th><th>Shout-outs</th><th>Recipient 1</th><th>Recipient 2</th><th>Status</th></tr></thead><tbody>${state.participants.map(participant => {
              const authorId = String(participant.id);
              const count = requiredCount(authorId);
              const assignments = assignmentIds(authorId);
              const first = assignments[0] || '';
              const second = assignments[1] || '';
              return `<tr>
                <td><span class="identity blurred" id="assign-name-${authorId}">${esc(participant.name)}</span> <button class="btn-ghost btn-small" onclick="toggleIdentity('assign-name-${authorId}')">Reveal</button></td>
                <td><select id="shoutout-count-${authorId}" data-fac-draft="shoutout-count-${authorId}" onchange="setShoutoutCount('${authorId}',this.value)"><option value="1"${count === 1 ? ' selected' : ''}>1 person</option><option value="2"${count === 2 ? ' selected' : ''}>2 people</option></select></td>
                <td><select id="assignment-${authorId}-0" data-fac-draft="assignment-${authorId}-0" onchange="setAssignmentSlot('${authorId}',0,this.value)"><option value="">Choose or randomise</option>${optionMarkup(authorId, first, second)}</select></td>
                <td>${count === 2
                  ? `<select id="assignment-${authorId}-1" data-fac-draft="assignment-${authorId}-1" onchange="setAssignmentSlot('${authorId}',1,this.value)"><option value="">Choose or randomise</option>${optionMarkup(authorId, second, first)}</select>`
                  : '<span class="hint">Not required</span>'}</td>
                <td>${assignmentStatus(authorId)}</td>
              </tr>`;
            }).join('')}</tbody></table></div>`}
        <div class="hint" style="margin-top:14px">A receiver can be selected more than once across the team. A writer cannot receive themselves or the same person twice.</div>
      </div>
      <div class="panel">
        <h3>Submitted Shout-outs</h3>
        ${typeof renderShoutoutAdmin === 'function' ? renderShoutoutAdmin() : ''}
      </div>`;
  }

  function setShoutoutCount(authorId, rawCount) {
    ensureStateShape();
    const count = Number(rawCount) === 2 ? 2 : 1;
    countSettings()[authorId] = count;
    const existing = normaliseAssignment(state.assignments?.[authorId]).slice(0, count);
    if (existing.length) state.assignments[authorId] = existing;
    else delete state.assignments[authorId];
    saveState();
  }

  function setAssignmentSlot(authorId, rawSlot, recipientId) {
    ensureStateShape();
    const slot = Number(rawSlot) === 1 ? 1 : 0;
    const count = requiredCount(authorId);
    if (slot >= count) return;

    const selections = assignmentIds(authorId);
    const value = String(recipientId || '');
    if (value === String(authorId)) return toast('A participant cannot receive themselves.');
    if (value && selections.some((id, index) => index !== slot && id === value)) {
      return toast('Choose two different people for this participant.');
    }
    if (slot === 1 && value && !selections[0]) {
      return toast('Choose recipient 1 first.');
    }

    if (!value) {
      selections.splice(slot, 1);
    } else {
      selections[slot] = value;
    }
    const cleaned = normaliseAssignment(selections).slice(0, count);
    if (cleaned.length) state.assignments[authorId] = cleaned;
    else delete state.assignments[authorId];
    saveState();
  }

  function fillRandomMissingSlots() {
    ensureStateShape();
    if ((state.participants || []).length < 2) return toast('Add at least two participants.');
    const allIds = state.participants.map(person => String(person.id));
    let missing = 0;

    for (const participant of state.participants) {
      const authorId = String(participant.id);
      const count = requiredCount(authorId);
      const selections = validRecipientIds(authorId);
      while (selections.length < count) {
        const candidates = allIds.filter(id => id !== authorId && !selections.includes(id));
        if (!candidates.length) break;
        const selected = candidates[Math.floor(Math.random() * candidates.length)];
        selections.push(selected);
      }
      if (selections.length) state.assignments[authorId] = selections;
      else delete state.assignments[authorId];
      missing += Math.max(0, count - selections.length);
    }

    saveState();
    if (missing) toast('Some two-person assignments need at least three participants.');
    else toast('All required shout-out slots are ready.');
  }

  function clearAllAssignments() {
    state.assignments = {};
    guardedResetWheel(true);
    saveState();
  }

  function renderRevealCards(recipientIds) {
    return `<div class="${recipientIds.length > 1 ? 'grid-2' : ''}" style="margin-top:10px;${recipientIds.length > 1 ? '' : 'display:grid;grid-template-columns:minmax(0,1fr);'}">${recipientIds.map(recipientId => {
      const recipient = getParticipant(recipientId);
      return `<div class="assignment-reveal" style="display:block">${avatarPicture(recipient?.avatarId)}<span class="eyebrow">You got:</span><strong>${esc(recipient?.name || 'Your assigned teammate')}</strong><div class="hint">Only you and the facilitator can see this assignment.</div></div>`;
    }).join('')}</div>`;
  }

  function renderSeparateForms(recipientIds) {
    return recipientIds.map((recipientId, index) => {
      const recipient = getParticipant(recipientId);
      const value = drafts[recipientId] || '';
      return `<div class="sticky" style="margin-bottom:18px"><h3 style="margin-top:0">Shout-out ${index + 1}: ${esc(recipient?.name || 'Assigned teammate')}</h3><p>What did this person do during the iteration that helped you, the team or the work?</p><textarea id="shoutout-text-${recipientId}" oninput="window.__whpSetTwoShoutoutDraft('${recipientId}',this.value)" placeholder="Describe the action and its positive impact...">${esc(value)}</textarea></div>`;
    }).join('');
  }

  function participantShoutoutMulti(participant) {
    ensureStateShape();
    const recipients = validRecipientIds(participant.id);
    if (!recipients.length) {
      guardedResetWheel(true);
      return '<div class="panel"><div class="empty">Your assignment is not ready yet. Ask the facilitator to prepare the wheel.</div></div>';
    }

    const pending = pendingRecipientIds(participant.id);
    const completed = ownShoutouts(participant.id).filter(item => recipients.includes(String(item.recipientId || ''))).length;
    if (!pending.length) {
      guardedResetWheel(true);
      return `<div class="panel"><div class="empty">Your ${recipients.length === 2 ? 'two shout-outs have' : 'shout-out has'} been submitted. The writer stays hidden on the shared screen.</div></div>`;
    }

    const key = pending.join('|');
    if (wheelState.key && wheelState.key !== key) guardedResetWheel(true);
    wheelState.key = key;

    return `<div class="comic-card">
      ${completed ? `<div class="pill green" style="margin-bottom:14px">${completed}/${recipients.length} already submitted</div>` : ''}
      <div class="wheel-wrap"><div class="wheel-pointer"></div><div class="wheel-stage"><div id="participant-wheel" class="wheel">${wheelNameLabels(participant.id)}</div><div id="wheel-label" class="wheel-label">Spin to reveal<br>${pending.length === 2 ? 'your two assignments' : 'your assignment'}</div></div></div>
      <div style="text-align:center"><button type="button" id="spin-btn" class="btn-primary" onclick="spinWheel()">Spin Wheel</button></div>
      <div id="assignment-reveal" class="hidden" aria-live="polite"></div>
      <div id="shoutout-form" class="hidden" style="max-width:820px;margin:24px auto 0">${renderSeparateForms(pending)}<button type="button" class="btn-dark" onclick="submitShoutouts()">Submit ${pending.length === 2 ? 'both shout-outs' : 'shout-out'} privately</button></div>
    </div>`;
  }

  function scheduleWheelCompletion() {
    if (wheelState.timerId) clearTimeout(wheelState.timerId);
    const wait = Math.max(0, wheelState.endsAt - Date.now());
    wheelState.timerId = setTimeout(() => {
      wheelState.timerId = null;
      wheelState.spun = false;
      wheelState.revealed = true;
      wheelState.formVisible = true;
      syncWheelMulti();

      requestAnimationFrame(() => {
        const form = document.getElementById('shoutout-form');
        if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }, wait);
  }

  function syncWheelMulti() {
    const participant = currentParticipant();
    if (!participant) return;
    const pending = pendingRecipientIds(participant.id);
    const key = pending.join('|');
    const wheel = document.getElementById('participant-wheel');
    if (!wheel || !pending.length) return;
    if (wheelState.key && wheelState.key !== key) guardedResetWheel(true);
    wheelState.key = key;

    const label = document.getElementById('wheel-label');
    const reveal = document.getElementById('assignment-reveal');
    const form = document.getElementById('shoutout-form');
    const button = document.getElementById('spin-btn');
    if (wheelState.finalAngle != null) wheel.style.transform = `rotate(${wheelState.finalAngle}deg)`;

    if (wheelState.revealed) {
      label.textContent = pending.length === 2 ? 'Two names revealed — only you can see them' : 'Name revealed — only you can see it';
      button.disabled = true;
      reveal.innerHTML = `${renderRevealCards(pending)}<div style="margin-top:16px;text-align:center"><button type="button" class="btn-primary" onclick="continueFromWheelResult()">Continue to write ${pending.length === 2 ? 'shout-outs' : 'shout-out'}</button></div>`;
      reveal.classList.remove('hidden');
      form.classList.toggle('hidden', !wheelState.formVisible);
      for (const recipientId of pending) {
        const textarea = document.getElementById(`shoutout-text-${recipientId}`);
        const draft = drafts[recipientId];
        if (
          textarea &&
          document.activeElement !== textarea &&
          draft != null &&
          textarea.value !== draft
        ) {
          textarea.value = draft;
        }
      }
      return;
    }

    if (wheelState.spun) {
      label.textContent = 'Spinning...';
      button.disabled = true;
      reveal.classList.add('hidden');
      form.classList.add('hidden');
      scheduleWheelCompletion();
      return;
    }

    label.innerHTML = `Spin to reveal<br>${pending.length === 2 ? 'your two assignments' : 'your assignment'}`;
    button.disabled = false;
    reveal.classList.add('hidden');
    form.classList.add('hidden');
  }

  function spinWheelMulti() {
    if (wheelState.spun || wheelState.revealed) return;
    const participant = currentParticipant();
    const pending = participant ? pendingRecipientIds(participant.id) : [];
    if (!pending.length) return toast('Your assignment is still loading. Try again in a moment.');
    wheelState.key = pending.join('|');
    wheelState.spun = true;
    wheelState.revealed = false;
    wheelState.formVisible = false;
    wheelState.finalAngle = 1080 + Math.floor(Math.random() * 360);
    wheelState.endsAt = Date.now() + 2400;
    syncWheelMulti();
  }

  function continueFromWheelMulti() {
    if (!wheelState.revealed) return;
    wheelState.formVisible = true;
    syncWheelMulti();
    const participant = currentParticipant();
    const firstRecipient = participant ? pendingRecipientIds(participant.id)[0] : null;
    const form = document.getElementById('shoutout-form');
    const textarea = firstRecipient ? document.getElementById(`shoutout-text-${firstRecipient}`) : null;
    if (form) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (textarea) textarea.focus({ preventScroll: true });
  }

  function repairAssignmentFromPayload(payload) {
    if (!payload || typeof payload !== 'object' || typeof state === 'undefined' || !state) return false;
    const participantId = String(
      payload.participant_id ||
      (typeof currentParticipantId !== 'undefined' && currentParticipantId) ||
      localStorage.getItem(participantIdKey) ||
      ''
    );
    if (!participantId) return false;

    const raw = payload.state?.assignments?.[participantId];
    if (raw == null) return false;

    const ids = normaliseAssignment(raw);
    const previousIds = normaliseAssignment(state.assignments?.[participantId]);
    let changed = JSON.stringify(previousIds) !== JSON.stringify(ids);

    state.assignments = state.assignments || {};
    state.assignments[participantId] = ids;

    const payloadParticipants = Array.isArray(payload.state?.participants)
      ? payload.state.participants
      : [];
    const payloadIds = new Set(
      payloadParticipants.map(person => String(person?.id || '')).filter(Boolean)
    );

    state.participants = Array.isArray(state.participants) ? state.participants : [];
    const beforeFilterLength = state.participants.length;
    state.participants = state.participants.filter(person => {
      const id = String(person?.id || '');
      return !person?.privateAssignmentOnly || payloadIds.has(id) || ids.includes(id);
    });
    if (state.participants.length !== beforeFilterLength) changed = true;

    for (const id of ids) {
      const incoming = payloadParticipants.find(person => String(person?.id) === id);
      if (!incoming) continue;

      const existing = state.participants.find(person => String(person?.id) === id);
      if (!existing) {
        state.participants.push({ ...incoming });
        changed = true;
        continue;
      }

      const incomingName = String(incoming.name || '');
      const incomingAvatar = incoming.avatarId || incoming.avatar_id || null;
      if (incomingName && existing.name !== incomingName) {
        existing.name = incomingName;
        changed = true;
      }
      if (incomingAvatar && existing.avatarId !== incomingAvatar) {
        existing.avatarId = incomingAvatar;
        changed = true;
      }
    }

    return changed;
  }

  async function submitAllPendingShoutouts() {
    if (window.submitGuard && !window.submitGuard()) return;
    try {
      const participant = currentParticipant();
      if (!participant) throw new Error('Join the session again.');
      const pending = pendingRecipientIds(participant.id);
      if (!pending.length) throw new Error('No pending shout-out assignment.');

      const items = pending.map(recipientId => ({
        id: typeof uid === 'function' ? uid() : `${Date.now()}-${Math.random()}`,
        recipientId,
        text: String(document.getElementById(`shoutout-text-${recipientId}`)?.value || drafts[recipientId] || '').trim()
      }));
      const incomplete = items.find(item => item.text.length < 12);
      if (incomplete) {
        const recipient = getParticipant(incomplete.recipientId);
        return toast(`Write a more specific compliment for ${recipient?.name || 'your assigned teammate'}.`);
      }

      const token = localStorage.getItem(tokenKey) || '';
      const configured = Boolean(supabaseUrl && cfg.supabasePublishableKey && token);
      if (configured) {
        const response = await fetch(`${supabaseUrl}/rest/v1/rpc/whp_participant_action`, {
          method: 'POST',
          headers: {
            apikey: String(cfg.supabasePublishableKey).trim(),
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            p_code: sessionCode,
            p_token: token,
            p_action: 'submit_shoutout',
            p_payload: { items }
          })
        });
        const text = await response.text();
        let payload = null;
        if (text) {
          try { payload = JSON.parse(text); } catch { payload = text; }
        }
        if (!response.ok) {
          const detail = typeof payload === 'string'
            ? payload
            : payload?.message || payload?.details || payload?.hint || `HTTP_${response.status}`;
          throw new Error(detail);
        }
        if (payload?.state && typeof migrateState === 'function') state = migrateState(payload.state);
        if (payload?.participant_id) {
          currentParticipantId = payload.participant_id;
          localStorage.setItem(participantIdKey, currentParticipantId);
        }
        repairAssignmentFromPayload(payload);
      } else {
        for (const item of items) {
          state.shoutouts.push({
            id: item.id,
            authorId: participant.id,
            clientParticipantId: participant.id,
            recipientId: item.recipientId,
            text: item.text,
            createdAt: Date.now()
          });
        }
        saveState();
      }

      for (const item of items) delete drafts[item.recipientId];
      guardedResetWheel(true);
      renderParticipantHub();
      toast(items.length === 2 ? 'Both shout-outs submitted.' : 'Shout-out submitted.');
    } catch (error) {
      console.error(error);
      const message = String(error?.message || error || 'Unable to submit shout-outs');
      if (/ALREADY_SUBMITTED/.test(message)) toast('One of these shout-outs was already submitted. Refresh and try again.');
      else if (/COMPLIMENT_TOO_SHORT/.test(message)) toast('Write a more specific compliment for each person.');
      else toast(message);
    } finally {
      if (window.submitDone) window.submitDone();
    }
  }

  async function removeParticipantMulti(id) {
    if (!(await askConfirm('Remove participant?', 'Their submissions and assignments will also be removed.', 'Remove'))) return;
    state.participants = state.participants.filter(person => String(person.id) !== String(id));
    delete state.assignments[id];
    if (state.settings?.shoutoutCounts) delete state.settings.shoutoutCounts[id];
    for (const authorId of Object.keys(state.assignments || {})) {
      const remaining = normaliseAssignment(state.assignments[authorId]).filter(recipientId => recipientId !== String(id));
      if (remaining.length) state.assignments[authorId] = remaining;
      else delete state.assignments[authorId];
    }
    state.shoutouts = state.shoutouts.filter(item =>
      String(item.authorId || item.clientParticipantId || '') !== String(id) && String(item.recipientId || '') !== String(id)
    );
    state.scanResponses = state.scanResponses.filter(item => String(item.participantId || item.clientParticipantId || '') !== String(id));
    state.problems = state.problems.filter(item => String(item.authorId || item.clientParticipantId || '') !== String(id));
    state.votes = state.votes.filter(item => String(item.participantId || item.clientParticipantId || '') !== String(id));
    state.responsibilities = state.responsibilities.filter(item => String(item.participantId || '') !== String(id));
    saveState();
  }

  function participantCompletionMulti(participant) {
    const parts = [];
    const required = validRecipientIds(participant.id).length || requiredCount(participant.id);
    const submitted = ownShoutouts(participant.id).filter(item =>
      validRecipientIds(participant.id).includes(String(item.recipientId || ''))
    ).length;
    if (submitted) parts.push(`<span class="pill ${submitted >= required ? 'green' : 'yellow'}">Shout-outs ${submitted}/${required}</span>`);
    if (state.scanResponses.some(item => String(item.participantId || item.clientParticipantId || '') === String(participant.id))) parts.push('<span class="pill green">Scan</span>');
    if (state.problems.some(item => String(item.authorId || item.clientParticipantId || '') === String(participant.id))) parts.push('<span class="pill green">Problem</span>');
    if (state.votes.some(item => String(item.participantId || item.clientParticipantId || '') === String(participant.id))) parts.push('<span class="pill green">Vote</span>');
    if (state.responsibilities.some(item => String(item.participantId || '') === String(participant.id))) parts.push('<span class="pill green">Responsibility</span>');
    return parts.length ? parts.join(' ') : '<span class="pill">None</span>';
  }

  function expectedShoutoutTotal() {
    const explicit = Number(state?.expectedShoutoutTotal);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    if (state?.settings?.shoutoutCounts && (state.participants || []).length) {
      return state.participants.reduce((sum, participant) => sum + requiredCount(participant.id), 0);
    }
    return (state.participants || []).length;
  }

  function sharedShoutoutsMulti() {
    const shoutouts = Array.isArray(state.shoutouts) ? state.shoutouts : [];
    const expected = expectedShoutoutTotal();
    if (!shoutouts.length) {
      return `<div class="shared-instruction"><strong>Shout-outs are open.</strong><br>Each participant privately reveals one or two assigned people and writes a separate compliment for each.</div><div class="shared-count">0${expected ? ` of ${expected}` : ''} collected</div>`;
    }
    return `<div class="shared-instruction"><strong>All submitted shout-outs.</strong><br>The receiver's name is shown, while the writer remains private.</div><div class="shared-count">${shoutouts.length}${expected ? ` of ${expected}` : ''} shout-outs collected</div><div class="note-grid">${shoutouts.map(item => {
      const receiver = typeof getParticipant === 'function' ? getParticipant(item.recipientId) : null;
      const receiverName = String(item.recipientName || item.receiverName || receiver?.name || 'Unknown receiver');
      const avatarId = item.recipientAvatarId || receiver?.avatarId || null;
      const receiverAvatar = avatarId ? avatarInline(avatarId) : '';
      return `<div class="web-note"><h4>${receiverAvatar} For ${esc(receiverName)}</h4><p>${esc(item.text || '')}</p><div class="meta">Writer hidden</div></div>`;
    }).join('')}</div>`;
  }

  function install() {
    if (typeof state === 'undefined' || typeof renderParticipantHub !== 'function' || typeof renderFacilitator !== 'function') {
      setTimeout(install, 50);
      return;
    }

    ensureStateShape();
    repairAssignmentFromPayload(window.__whpPrivatePayload);

    window.__whpNormaliseShoutoutAssignment = normaliseAssignment;
    window.__whpSetTwoShoutoutDraft = (recipientId, value) => { drafts[recipientId] = value; };

    window.renderAssignmentsTab = renderAssignmentsWithTwoSlots;
    window.setShoutoutCount = setShoutoutCount;
    window.setAssignmentSlot = setAssignmentSlot;
    window.setAssignment = function legacySetAssignment(authorId, recipientId) {
      setAssignmentSlot(authorId, 0, recipientId);
    };
    window.fillRandomAssignments = fillRandomMissingSlots;
    window.clearAssignments = clearAllAssignments;
    window.removeParticipant = removeParticipantMulti;
    window.participantCompletion = participantCompletionMulti;

    window.participantShoutout = participantShoutoutMulti;
    window.resetWheelLocalState = guardedResetWheel;
    window.spinWheel = spinWheelMulti;
    window.continueFromWheelResult = continueFromWheelMulti;
    window.syncWheelUIFromLocalState = syncWheelMulti;
    window.submitShoutouts = submitAllPendingShoutouts;
    window.submitShoutout = submitAllPendingShoutouts;
    window.sharedShoutouts = sharedShoutoutsMulti;

    // online.js may request a participant rerender when polling notices a
    // server-state difference. Never replace an active shout-out textarea: it
    // removes focus and interrupts the sentence being typed. This covers both
    // the one-person and two-person versions of the form.
    if (!window.renderParticipantHub.__whpShoutoutTypingGuard) {
      const originalRenderParticipantHub = window.renderParticipantHub;
      const guardedRenderParticipantHub = function (...args) {
        if (participantIsTypingShoutout()) return;
        return originalRenderParticipantHub.apply(this, args);
      };
      guardedRenderParticipantHub.__whpShoutoutTypingGuard = true;
      window.renderParticipantHub = guardedRenderParticipantHub;
      try { renderParticipantHub = guardedRenderParticipantHub; } catch (_) {}
    }

    window.addEventListener('whp:private-payload', event => {
      setTimeout(() => {
        const repaired = repairAssignmentFromPayload(event.detail?.payload);
        const typingShoutout = participantIsTypingShoutout();

        if (
          repaired &&
          !typingShoutout &&
          document.getElementById('screen-participant-hub')?.classList.contains('active')
        ) {
          renderParticipantHub();
        }
      }, 0);
    });

    if (document.getElementById('screen-facilitator')?.classList.contains('active')) renderFacilitator();
    if (document.getElementById('screen-participant-hub')?.classList.contains('active')) renderParticipantHub();
    if (document.getElementById('screen-shared')?.classList.contains('active')) renderShared();
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }
})();

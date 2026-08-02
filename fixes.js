/* Targeted live fixes for the Team Retro GitHub Pages build.
   - Keep facilitator inputs stable while editing.
   - Make Team Scan written reasons optional.
   - Sort shared Team Scan results from lowest to highest average.
   - Restore the participant-private wheel assignment without facilitator login.
*/
(() => {
  'use strict';

  const cfg = window.WHP_CONFIG || {};
  const normalisedSupabaseUrl = String(cfg.supabaseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '');
  const params = new URLSearchParams(window.location.search);
  const sessionCode = String(params.get('session') || cfg.defaultSessionCode || 'TEAM-RETRO')
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '');
  const tokenKey = `whpParticipantToken:${sessionCode}`;
  const participantIdKey = `whpParticipantId:${sessionCode}`;

  const firstValue = (object, keys) => {
    if (!object || typeof object !== 'object') return null;
    for (const key of keys) {
      const value = object[key];
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return null;
  };

  const asParticipant = raw => {
    if (!raw || typeof raw !== 'object') return null;
    const nested = raw.recipient || raw.assigned_participant || raw.assignedParticipant || raw.participant;
    const source = nested && typeof nested === 'object' ? nested : raw;
    const id = firstValue(source, [
      'id', 'participant_id', 'participantId', 'recipient_id', 'recipientId',
      'assigned_participant_id', 'assignedParticipantId'
    ]);
    if (!id) return null;
    return {
      id: String(id),
      name: String(firstValue(source, [
        'name', 'participant_name', 'participantName', 'recipient_name',
        'recipientName', 'assigned_name', 'assignedName'
      ]) || ''),
      avatarId: firstValue(source, [
        'avatarId', 'avatar_id', 'recipient_avatar_id', 'recipientAvatarId',
        'assigned_avatar_id', 'assignedAvatarId'
      ]) || null
    };
  };

  function extractPrivateAssignment(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const participantId = String(
      firstValue(payload, ['participant_id', 'participantId']) ||
      (typeof currentParticipantId !== 'undefined' && currentParticipantId) ||
      localStorage.getItem(participantIdKey) ||
      ''
    );
    if (!participantId) return null;

    const containers = [
      payload,
      payload.private,
      payload.viewer,
      payload.participant,
      payload.private_data,
      payload.participant_data
    ].filter(Boolean);

    let recipientId = null;
    let recipient = null;

    for (const container of containers) {
      recipientId = recipientId || firstValue(container, [
        'recipient_id', 'recipientId', 'assignment_recipient_id', 'assignmentRecipientId',
        'assigned_participant_id', 'assignedParticipantId'
      ]);

      for (const key of [
        'assignment', 'private_assignment', 'participant_assignment',
        'recipient', 'assignment_recipient', 'assigned_participant'
      ]) {
        const candidate = container?.[key];
        if (!candidate) continue;
        if (typeof candidate === 'string' || typeof candidate === 'number') {
          recipientId = recipientId || String(candidate);
        } else if (typeof candidate === 'object') {
          recipient = recipient || asParticipant(candidate);
          recipientId = recipientId || recipient?.id || firstValue(candidate, [
            'recipient_id', 'recipientId', 'assigned_participant_id', 'assignedParticipantId'
          ]);
        }
      }
    }

    const payloadState = payload.state || {};
    recipientId = recipientId || payloadState.assignments?.[participantId] || null;
    if (recipientId) recipientId = String(recipientId);

    if (!recipient && recipientId) {
      recipient = asParticipant((payloadState.participants || []).find(item => String(item?.id) === recipientId));
    }

    const topLevelName = firstValue(payload, [
      'recipient_name', 'recipientName', 'assignment_name', 'assignmentName',
      'assigned_name', 'assignedName'
    ]);
    const topLevelAvatar = firstValue(payload, [
      'recipient_avatar_id', 'recipientAvatarId', 'assignment_avatar_id',
      'assignmentAvatarId', 'assigned_avatar_id', 'assignedAvatarId'
    ]);

    if (recipientId && !recipient) {
      recipient = { id: recipientId, name: String(topLevelName || ''), avatarId: topLevelAvatar || null };
    } else if (recipient) {
      if (!recipient.name && topLevelName) recipient.name = String(topLevelName);
      if (!recipient.avatarId && topLevelAvatar) recipient.avatarId = topLevelAvatar;
    }

    if (!recipientId && recipient?.id) recipientId = recipient.id;
    if (!recipientId) return null;
    return { participantId, recipientId, recipient };
  }

  function mergePrivateAssignment(payload) {
    if (typeof state === 'undefined' || !state) return false;
    const assignment = extractPrivateAssignment(payload);
    if (!assignment) return false;

    state.assignments = state.assignments || {};
    const previousRecipientId = state.assignments[assignment.participantId] || null;
    state.assignments[assignment.participantId] = assignment.recipientId;

    state.participants = Array.isArray(state.participants) ? state.participants : [];
    const existing = state.participants.find(item => String(item?.id) === assignment.recipientId);
    const incoming = assignment.recipient || { id: assignment.recipientId, name: '', avatarId: null };

    if (existing) {
      if (incoming.name) existing.name = incoming.name;
      if (incoming.avatarId) existing.avatarId = incoming.avatarId;
    } else {
      state.participants.push({
        id: assignment.recipientId,
        name: incoming.name || 'Your assigned team mate',
        avatarId: incoming.avatarId || null,
        privateAssignmentOnly: true
      });
    }

    return previousRecipientId !== assignment.recipientId || !existing;
  }
  window.__whpMergePrivateAssignment = mergePrivateAssignment;

  function installWheelRepair() {
    mergePrivateAssignment(window.__whpPrivatePayload);
    window.addEventListener('whp:private-payload', event => {
      const changed = mergePrivateAssignment(event.detail?.payload);
      const participantHub = document.getElementById('screen-participant-hub');
      if (changed && participantHub?.classList.contains('active') && typeof renderParticipantHub === 'function') {
        renderParticipantHub();
      }
    });

    if (typeof participantShoutout === 'function') {
      const originalParticipantShoutout = participantShoutout;
      participantShoutout = window.participantShoutout = function repairedParticipantShoutout(participant) {
        mergePrivateAssignment(window.__whpPrivatePayload);
        return originalParticipantShoutout(participant);
      };
    }
  }

  function installFacilitatorInputRepair() {
    if (typeof renderScanTab === 'function') {
      renderScanTab = window.renderScanTab = function repairedRenderScanTab() {
        const tab = document.getElementById('tab-scan');
        if (!tab) return;
        tab.innerHTML = `
          <div class="panel"><div class="toolbar"><div><h3 style="margin:0">Assessment Categories</h3><p class="panel-sub">Participants score each category from 1 to 5. Written reasons are optional.</p></div><button class="btn-primary right" onclick="addCategory()">Add Category</button></div>
            <div class="table-wrap"><table><thead><tr><th>Group</th><th>Category</th><th>Description</th><th></th></tr></thead><tbody>${state.categories.map(c => `
              <tr>
                <td><input id="scan-group-${c.id}" data-fac-draft="scan-group-${c.id}" value="${esc(c.group)}" oninput="localUI.facilitatorDraftInputs['scan-group-${c.id}']=this.value" onchange="editCategory('${c.id}','group',this.value)"></td>
                <td><input id="scan-name-${c.id}" data-fac-draft="scan-name-${c.id}" value="${esc(c.name)}" oninput="localUI.facilitatorDraftInputs['scan-name-${c.id}']=this.value" onchange="editCategory('${c.id}','name',this.value)"></td>
                <td><textarea id="scan-description-${c.id}" data-fac-draft="scan-description-${c.id}" style="min-height:70px" oninput="localUI.facilitatorDraftInputs['scan-description-${c.id}']=this.value" onchange="editCategory('${c.id}','description',this.value)">${esc(c.description)}</textarea></td>
                <td><button class="btn-danger btn-small" onclick="removeCategory('${c.id}')">Remove</button></td>
              </tr>`).join('')}</tbody></table></div>
          </div>
          <div class="panel"><h3>Team Scan Results</h3>${renderScanAdminResults()}</div>`;
      };
    }

    if (typeof renderFacilitator === 'function') {
      const originalRenderFacilitator = renderFacilitator;
      let renderQueued = false;
      const isEditingFacilitatorField = () => {
        const active = document.activeElement;
        return Boolean(
          active &&
          active.closest?.('#screen-facilitator') &&
          active.matches?.('input, textarea, select, [contenteditable="true"]')
        );
      };

      renderFacilitator = window.renderFacilitator = function guardedRenderFacilitator(...args) {
        if (isEditingFacilitatorField()) {
          renderQueued = true;
          return;
        }
        renderQueued = false;
        return originalRenderFacilitator.apply(this, args);
      };

      document.addEventListener('focusout', event => {
        if (!renderQueued || !event.target?.closest?.('#screen-facilitator')) return;
        setTimeout(() => {
          if (!isEditingFacilitatorField() && renderQueued) renderFacilitator();
        }, 0);
      });
    }
  }

  function installOptionalScanReasons() {
    if (typeof phaseInstruction === 'function') {
      const originalPhaseInstruction = phaseInstruction;
      phaseInstruction = window.phaseInstruction = function repairedPhaseInstruction(phase) {
        if (phase === 'scan') return 'Score every category. Written reasons are optional.';
        return originalPhaseInstruction(phase);
      };
    }

    if (typeof participantScan === 'function') {
      participantScan = window.participantScan = function repairedParticipantScan(participant) {
        const existing = state.scanResponses.find(item =>
          item.participantId === participant.id || item.clientParticipantId === participant.id
        );
        if (existing) {
          return '<div class="panel"><div class="empty">Your team scan is complete. Scores are shown only in aggregate, and any written reasons are anonymous.</div></div>';
        }
        const groups = [...new Set(state.categories.map(category => category.group))];
        return `<div class="panel"><h3>${esc(state.settings.labels.scan)}</h3><p class="panel-sub">1 = rarely visible, 3 = inconsistent, 5 = consistently visible even under pressure. Written reasons are optional.</p>
          <form id="scan-form">${groups.map(group => `<h3 style="margin-top:26px;color:var(--yellow)">${esc(group)}</h3><div class="rating-grid">${state.categories.filter(category => category.group === group).map(category => `<div class="rating-card" data-category="${category.id}"><h4>${esc(category.name)}</h4><p>${esc(category.description)}</p><div class="score-row">${[1,2,3,4,5].map(score => `<button type="button" class="score-btn" onclick="selectScore('${category.id}',${score},this)">${score}</button>`).join('')}</div><div class="sticky"><label>Reason for your score <span class="hint">(optional)</span></label><textarea id="reason-${category.id}" placeholder="Optional: what situation or behaviour influenced your rating?"></textarea></div><input type="hidden" id="score-${category.id}"></div>`).join('')}</div>`).join('')}<button type="button" class="btn-primary" style="margin-top:20px" onclick="submitScan()">Submit Team Scan</button></form></div>`;
      };
    }

    submitScan = window.submitScan = async function submitScanWithOptionalReasons() {
      if (window.submitGuard && !window.submitGuard()) return;
      try {
        const answers = {};
        for (const category of state.categories) {
          const score = Number(document.getElementById(`score-${category.id}`)?.value);
          const reason = document.getElementById(`reason-${category.id}`)?.value.trim() || '';
          if (!score) {
            if (window.submitDone) window.submitDone();
            return toast(`Choose a score for ${category.name}`);
          }
          answers[category.id] = { score, reason };
        }

        const token = localStorage.getItem(tokenKey) || '';
        if (!token) {
          if (window.submitDone) window.submitDone();
          return toast('Join the session again.');
        }

        const endpoint = `${normalisedSupabaseUrl}/rest/v1/rpc/whp_participant_action`;
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            apikey: String(cfg.supabasePublishableKey || '').trim(),
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({
            p_code: sessionCode,
            p_token: token,
            p_action: 'submit_scan',
            p_payload: { id: typeof uid === 'function' ? uid() : `${Date.now()}-${Math.random()}`, answers }
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
        mergePrivateAssignment(payload);
        if (window.localUI) {
          localUI.draftReasons = {};
          localUI.scoreSelections = {};
        }
        renderParticipantHub();
        toast('Team scan submitted');
      } catch (error) {
        console.error(error);
        toast(String(error?.message || error || 'Unable to submit the team scan'));
      } finally {
        if (window.submitDone) window.submitDone();
      }
    };
  }

  function installSharedScanOrdering() {
    sharedScan = window.sharedScan = function orderedSharedScan() {
      if (!state.scanResponses.length) {
        return `<div class="shared-instruction"><strong>Team Scan is open.</strong><br>Participants rate each category from 1 to 5. Written reasons are optional and anonymous.</div><div class="shared-count">0 of ${state.participants.length} submitted</div>`;
      }

      const completedCount = state.scanResponses.length;
      const categories = state.categories.map(category => {
        const values = state.scanResponses
          .map(response => Number(response.answers?.[category.id]?.score))
          .filter(value => Number.isFinite(value) && value >= 1 && value <= 5);
        const reasons = state.scanResponses
          .map(response => String(response.answers?.[category.id]?.reason || '').trim())
          .filter(Boolean);
        const average = values.length
          ? values.reduce((sum, value) => sum + value, 0) / values.length
          : null;
        return { category, values, reasons, average };
      }).sort((left, right) => {
        if (left.average === null && right.average === null) {
          return left.category.name.localeCompare(right.category.name);
        }
        if (left.average === null) return 1;
        if (right.average === null) return -1;
        return left.average - right.average || left.category.name.localeCompare(right.category.name);
      });

      const cards = categories.map(({ category, values, reasons, average }) => {
        if (average === null) {
          return `<article class="shared-scan-category"><div class="shared-scan-summary"><div><span class="pill yellow">${esc(category.group)}</span><h4>${esc(category.name)}</h4><p class="shared-scan-description">${esc(category.description)}</p></div><div class="shared-average"><strong>–</strong><span>Waiting</span></div></div><div class="shared-no-reasons" style="margin-top:18px">No ratings have been submitted for this category yet.</div></article>`;
        }
        const range = Math.max(...values) - Math.min(...values);
        const spreadLabel = range >= 3
          ? 'Different experiences detected'
          : range === 0
            ? 'Strong agreement'
            : `Score range: ${range}`;
        return `<article class="shared-scan-category"><div class="shared-scan-summary"><div><span class="pill yellow">${esc(category.group)}</span><h4>${esc(category.name)}</h4><p class="shared-scan-description">${esc(category.description)}</p><div class="shared-scan-meta"><span class="pill blue">${values.length} response${values.length === 1 ? '' : 's'}</span><span class="pill ${range >= 3 ? 'red' : 'green'}">${esc(spreadLabel)}</span></div></div><div class="shared-average"><strong>${average.toFixed(1)}</strong><span>Average / 5</span></div></div><div class="meter" style="margin-top:17px"><span style="width:${Math.max(0, Math.min(100, average / 5 * 100))}%"></span></div><h5 class="shared-ticket-heading">Written reasons (${reasons.length})</h5>${reasons.length ? `<div class="shared-ticket-grid">${reasons.map(reason => `<div class="shared-reason-ticket">${esc(reason)}</div>`).join('')}</div>` : '<div class="shared-no-reasons">No written reasons were added for this category.</div>'}</article>`;
      }).join('');

      return `<div class="shared-instruction"><strong>Results are ordered from the lowest average to the highest.</strong><br>Individual ratings are never displayed. Optional written reasons appear as anonymous tickets.</div><div class="shared-count">${completedCount} of ${state.participants.length} scans completed</div><section class="panel"><div class="shared-scan-category-stack">${cards}</div></section>`;
    };
  }

  function install() {
    if (typeof state === 'undefined' || typeof renderParticipantHub !== 'function') return;
    installWheelRepair();
    installFacilitatorInputRepair();
    installOptionalScanReasons();
    installSharedScanOrdering();

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

/* Shared-screen public results fix.
   - Shows every public shout-out and every Team Scan response.
   - Shows the receiver's name on each shout-out.
   - Treats every Team Scan item as one independent question.
   - Ranks questions ONLY by numeric rating average, lowest to highest.
   - Optional written responses are displayed but never used in ranking.
*/
(() => {
  'use strict';

  function installSharedResultFixes() {
    if (typeof state === 'undefined' || typeof renderShared !== 'function') {
      window.setTimeout(installSharedResultFixes, 50);
      return;
    }

    sharedShoutouts = window.sharedShoutouts = function sharedAllShoutouts() {
      const shoutouts = Array.isArray(state.shoutouts) ? state.shoutouts : [];
      if (!shoutouts.length) {
        return `<div class="shared-instruction"><strong>Shout-outs are open.</strong><br>Each participant privately spins the wheel and submits one specific compliment.</div><div class="shared-count">0 of ${state.participants.length} submitted</div>`;
      }

      return `<div class="shared-instruction"><strong>All submitted shout-outs.</strong><br>The receiver's name is shown, while the writer remains private.</div><div class="shared-count">${shoutouts.length} of ${state.participants.length} shout-outs collected</div><div class="note-grid">${shoutouts.map(item => {
        const receiver = typeof getParticipant === 'function' ? getParticipant(item.recipientId) : null;
        const receiverName = String(
          item.recipientName ||
          item.receiverName ||
          receiver?.name ||
          'Unknown receiver'
        );
        const receiverAvatar = receiver?.avatarId ? avatarInline(receiver.avatarId) : '';
        return `<div class="web-note"><h4>${receiverAvatar} For ${esc(receiverName)}</h4><p>${esc(item.text || '')}</p><div class="meta">Writer hidden</div></div>`;
      }).join('')}</div>`;
    };

    sharedScan = window.sharedScan = function sharedQuestionsByAverageOnly() {
      const responses = Array.isArray(state.scanResponses) ? state.scanResponses : [];
      const questions = Array.isArray(state.categories) ? state.categories : [];

      if (!responses.length) {
        return `<div class="shared-instruction"><strong>Team Scan is open.</strong><br>Participants rate every question from 1 to 5. Written responses are optional and anonymous.</div><div class="shared-count">0 of ${state.participants.length} submitted</div>`;
      }

      const rankedQuestions = questions.map(question => {
        const ratings = responses
          .map(response => Number(response.answers?.[question.id]?.score))
          .filter(rating => Number.isFinite(rating) && rating >= 1 && rating <= 5);

        const writtenResponses = responses
          .map(response => String(response.answers?.[question.id]?.reason || '').trim())
          .filter(Boolean);

        const average = ratings.length
          ? ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length
          : null;

        return { question, ratings, writtenResponses, average };
      }).sort((left, right) => {
        // Questions without numeric ratings cannot have an average, so they go last.
        if (left.average === null && right.average === null) return 0;
        if (left.average === null) return 1;
        if (right.average === null) return -1;

        // This is the ONLY ranking comparison.
        // Written-response presence, count, length and content are not considered.
        return left.average - right.average;
      });

      const questionCards = rankedQuestions.map(({ question, ratings, writtenResponses, average }) => {
        if (average === null) {
          return `<article class="shared-scan-category"><div class="shared-scan-summary"><div><h4>${esc(question.name)}</h4><p class="shared-scan-description">${esc(question.description || '')}</p></div><div class="shared-average"><strong>–</strong><span>No ratings</span></div></div><div class="shared-no-reasons" style="margin-top:18px">No numeric ratings have been submitted for this question yet.</div></article>`;
        }

        return `<article class="shared-scan-category"><div class="shared-scan-summary"><div><h4>${esc(question.name)}</h4><p class="shared-scan-description">${esc(question.description || '')}</p><div class="shared-scan-meta"><span class="pill blue">${ratings.length} rating${ratings.length === 1 ? '' : 's'}</span></div></div><div class="shared-average"><strong>${average.toFixed(1)}</strong><span>Average / 5</span></div></div><div class="meter" style="margin-top:17px"><span style="width:${Math.max(0, Math.min(100, average / 5 * 100))}%"></span></div><h5 class="shared-ticket-heading">Optional written responses (${writtenResponses.length})</h5>${writtenResponses.length ? `<div class="shared-ticket-grid">${writtenResponses.map(response => `<div class="shared-reason-ticket">${esc(response)}</div>`).join('')}</div>` : '<div class="shared-no-reasons">No written response was added for this question.</div>'}</article>`;
      }).join('');

      return `<div class="shared-instruction"><strong>Questions are ranked only by their numeric rating average.</strong><br>Lowest average first, highest average last. Optional written responses are displayed underneath and never affect the order.</div><div class="shared-count">${responses.length} of ${state.participants.length} scans completed</div><section class="panel"><div class="shared-scan-category-stack">${questionCards}</div></section>`;
    };

    if (document.getElementById('screen-shared')?.classList.contains('active')) {
      renderShared();
    }
  }

  installSharedResultFixes();
})();

window.currentSources = [];
window.playFirstSource = function() {
    if (window.currentSources && window.currentSources.length > 0) {
        console.log('[PLAY BUTTON] Triggering playback for first source:', window.currentSources[0].fileName);
        handleSourceClick(window.currentSources[0], true);
    } else {
        console.warn('[PLAY BUTTON] No sources available yet.');
    }
};
let currentSeriesSeasons = null;
let sourceDB = null;
let searchInProgress = false;
let processedButtons = new Set(); // Prevent button loops
let lastClickedChatId = null; // Track most recent callback target
let lastClickedTime = 0;
let autoDownloadUniqueId = null; // Track file to download after regeneration
let lastBotUsername = null;
let lastStartParam = null;
let pendingDownloadRequest = null; // Track user-initiated download targeting
let currentSearchSessionId = 0;
let highestPageReached = new Map(); // chatId -> maxPageNum
let processedMessageIds = new Set(); // Prevent double-processing of bot responses

// Request Correlation
let activeRequests = new Map(); // providerChatId -> request[]
let pendingFileRequests = new Map(); // botChatId -> { startParam, sourceData }

// Provider States & Filtering
let providerStates = new Map(); // chatId -> { title, status, count }

// ── DATABASE LAYER handled in js/sources/db.js ─────────────

// ── PROVIDER SEARCH ──────────────────────────────────────
async function loadSources(item) {
  if (window.tdlibFatalError) {
    console.error("[SEARCH BLOCKED - TDLIB DEAD]");
    document.getElementById("sourceStatus").textContent = "Search unavailable (TDLib error)";
    return;
  }

  if (!localStorage.getItem('sv_session')) {
    console.warn("[SEARCH BLOCKED - NOT AUTHORIZED]");
    document.getElementById("sourceStatus").textContent = "Please sign in first";
    return;
  }

  currentDetailItem = item;
  const results = document.getElementById("sourceResults");
  const statusEl = document.getElementById("sourceStatus");
  const progressBar = document.querySelector(".source-progress-bar");
  const filterDropdown = document.getElementById("sourceFilter");

  currentSearchSessionId = Date.now();
  console.log(`[SEARCH SESSION CREATED] sessionId=${currentSearchSessionId}`);

  results.innerHTML = "";
  progressBar.style.display = "none";
  processedButtons.clear();
  processedMessageIds.clear();
  providerStates.clear();
  window.currentSources = [];
  window.selectedFilter = "all";

  // Reset filter dropdown
  if (filterDropdown) {
    filterDropdown.innerHTML = '<option value="all">All Sources (0)</option>';
    filterDropdown.value = "all";
  }

  const title = item.title || item.label;
  const year = item.year;

  // NEW: Initial Series State (Wait for episode selection)
  if ((item.type === 'tv' || item.sub === "TV SERIES") && !item.episode) {
      statusEl.textContent = "Select an episode to search releases";
      return;
  }

  statusEl.textContent = "Checking active tasks...";
  progressBar.style.display = "block";

  // 0. Proactive Media Lock
  const mediaId = String(item.id || item.tmdbId);
  const manager = window.downloadManager;
  const existingTasks = manager ? Array.from(manager.values()).filter(t => {
      if (!t.media) return false;
      const idMatch = String(t.media.tmdbId) === mediaId;
      if (!idMatch) return false;
      if (item.season && item.episode) {
          return Number(t.media.season) === Number(item.season) && Number(t.media.episode) === Number(item.episode);
      }
      return true;
  }) : [];

  if (existingTasks.length > 0) {
      for (const task of existingTasks) {
          // SELF-HEAL: If marked as completed but missing, or vice-versa
          if (window.electronAPI && task.progress.savePath) {
              const check = await window.electronAPI.verifyAndResumeFile({
                  fileId: task.telegram.fileId,
                  savePath: task.progress.savePath,
                  lastOffset: 0
              });
              if (check.success && task.progress.state !== 'completed') {
                  task.progress.state = 'completed';
                  task.progress.percent = 100;
              } else if (!check.success && task.progress.state === 'completed') {
                  task.progress.state = 'paused';
              }
          }

          const source = {
              uniqueId: task.telegram?.telegramUniqueId || task.taskId,
              fileName: task.media.fileName,
              size: task.media.totalSize,
              addon: task.discovery.providerName,
              addonId: task.discovery.providerId,
              itemId: task.discovery.messageId,
              fileId: task.telegram?.fileId,
              startParameter: task.discovery.lookupToken,
              fromCache: true,
              taskId: task.taskId
          };
          addSourceToUI(source, true);
      }
  }

  // 1. Try Cache First
  const cached = await getCachedSources(title, year);
  if (cached && cached.length > 0) {
    console.log(`[CACHE HIT] Found ${cached.length} sources for ${title}`);

    // For series, only use cache if it matches our season/episode intent
    const validatedCached = [];
    for (const s of cached) {
        const isRel = await isRelevant(s.fileName, item);
        if (!isRel) {
            console.log(`%c[CACHE REJECTED] %c${s.fileName}`, 'color: #ff4444; font-weight: bold;', 'color: #ff8888;');
            // PHASE 7B: POISON CACHE PROTECTION
            // If it's already in cache but fails relevance (e.g. from an old logic version), delete it.
            if (s.uniqueId) {
                await window.deleteCachedSource(s.uniqueId);
            }
            continue;
        }

        if (item.season && item.episode) {
            const sStr = `s${item.season.toString().padStart(2, '0')}`;
            const eStr = `e${item.episode.toString().padStart(2, '0')}`;
            const fn = (s.fileName || "").toLowerCase();
            if (fn.includes(sStr) && fn.includes(eStr)) {
                validatedCached.push(s);
            }
        } else {
            validatedCached.push(s);
        }
    }

    if (validatedCached.length > 0) {
        validatedCached.forEach(s => {
            const cid = String(s.addonId);
            if (!providerStates.has(cid)) {
                providerStates.set(cid, { title: s.addon, status: "DONE", count: 0 });
            }
            addSourceToUI(s, true);
        });

        statusEl.textContent = `Loaded ${window.currentSources.length} sources from cache`;
        progressBar.style.display = "none";

        console.log(`[BACKGROUND REFRESH] Triggering search for ${title}...`);
        searchProviders(title, year, true, item);
        return;
    }
  }

  // 2. Trigger Provider Search
  statusEl.textContent = "Searching providers...";
  await searchProviders(title, year, false, item);
}

async function searchProviders(title, year, isBackground = false, item = null) {
  if (window.tdlibFatalError) {
    console.error("[SEARCH BLOCKED - TDLIB DEAD]");
    return;
  }

  const stored = localStorage.getItem('sv_extensions');
  const extensions = stored ? JSON.parse(stored) : [];
  if (extensions.length === 0) {
    console.log("[SEARCH] No extensions installed");
    document.getElementById("sourceStatus").textContent = "No extensions added";
    document.querySelector(".source-progress-bar").style.display = "none";
    return;
  }

  // QUERY GENERATION (Phase 4A)
  let query = `${title} ${year}`;
  if (item && item.season && item.episode) {
      const s = item.season.toString().padStart(2, '0');
      const e = item.episode.toString().padStart(2, '0');
      query = `${title} S${s}E${e}`;
  }

  if (!isBackground) {
    activeRequests.clear();
  }

  searchInProgress = true;

  for (const ext of extensions) {
    const cid = String(ext.chatId);

    console.log(`[PROVIDER SEARCH START]`);
    console.log(`Provider: ${ext.title}`);
    console.log(`Chat ID: ${cid}`);
    console.log(`Query: ${query}`);

    if (!providerStates.has(cid)) {
        providerStates.set(cid, { title: ext.title, status: "LOADING", count: 0 });
        updateFilterDropdown();
    }

    // Individual Provider Timeout (60s)
    setTimeout(() => {
        const state = providerStates.get(cid);
        if (state && state.status === "LOADING") {
            state.status = "TIMEOUT";
            console.warn(`[PROVIDER TIMEOUT] ${ext.title}`);
            updateFilterDropdown();
            checkAllCompleted();
        }
    }, 60000);

    try {
      console.log(`[CHAT VERIFICATION START] Chat ID: ${cid}`);
      try {
        const chat = await window.tdClient.send({
          '@type': 'getChat',
          'chat_id': ext.chatId
        });
        console.log(`[CHAT VERIFIED] ID: ${chat.id}, Title: ${chat.title}, Type: ${chat.type['@type']}`);
        if (chat.permissions) console.log(`[CHAT PERMISSIONS]`, chat.permissions);
      } catch (chatErr) {
        console.error(`[CHAT NOT FOUND/ACCESS DENIED] ${ext.title} (${cid})`, chatErr);
        const state = providerStates.get(cid);
        if (state) state.status = "FAILED";
        continue;
      }

      console.log(`[SEND REQUEST]`, {
        chat_id: ext.chatId,
        query: query,
        provider: ext.title
      });

      console.log(`[SENDING QUERY] "${query}" to ${ext.title}`);
      const res = await window.tdClient.send({
        '@type': 'sendMessage',
        'chat_id': ext.chatId,
        'input_message_content': {
          '@type': 'inputMessageText',
          'text': { '@type': 'formattedText', 'text': query }
        }
      });

      console.log(`[SEND RESPONSE]`, JSON.stringify(res, null, 2));

      if (res && res.id) {
        if (!activeRequests.has(cid)) activeRequests.set(cid, []);
        activeRequests.get(cid).push({
            messageId: res.id,
            timestamp: Date.now(),
            title: title,
            year: year,
            season: item?.season,
            episode: item?.episode,
            sessionId: currentSearchSessionId
        });
        console.log(`[REQUEST REGISTERED] Provider: ${ext.title}, Msg ID: ${res.id}, Movie: ${title}`);
      } else {
        console.warn(`[SEND FAILED] Provider: ${ext.title}, No message ID returned in response`);
        const state = providerStates.get(cid);
        if (state) state.status = "FAILED";
      }
    } catch (e) {
      console.error(`[SEND FAILED] Provider: ${ext.title}, Error:`, e);
      const state = providerStates.get(cid);
      if (state) state.status = "FAILED";
      updateFilterDropdown();
    }
  }

  // Global search flag
  setTimeout(() => { searchInProgress = false; }, 90000);
}

function checkAllCompleted() {
    const states = Array.from(providerStates.values());
    const allDone = states.every(s => s.status !== "LOADING");
    if (allDone) {
        document.querySelector(".source-progress-bar").style.display = "none";
        document.getElementById("sourceStatus").textContent = `Search completed. Found ${window.currentSources.length} sources.`;

        // PHASE 7A: Final Search Cleanup
        console.log(`[SEARCH COMPLETE] All provider streams settled.`);

        // IMPORTANT: We do NOT clear activeRequests here anymore.
        // We keep them to allow bots that respond late (or after redirect) to correlate.
        // They will be cleared when a new search starts (in loadSources).

        // Reset pagination state
        if (highestPageReached) highestPageReached.clear();
    }
}

// ── MESSAGE PROCESSING ───────────────────────────────────
window.addEventListener('tdlib-update', (e) => {
  const update = e.detail;
  const type = update['@type'];

  if (window.DEBUG_DOWNLOADS && type !== 'updateFile') {
    console.log(`[RAW UPDATE] ${type}`, update);
  }

  if (type === 'updateAuthorizationState') {
    console.log(`[AUTH STATE]`, update.authorization_state);
  } else if (type === 'updateFatalError') {
    console.error(`[FATAL ERROR DETECTED]`, update);
    if (update.error) {
       console.error(`Error details: ${update.error.message} (${update.error.code})`);
    }
  }

  if (type === 'updateNewMessage') {
    handleProviderMessage(update.message);
  } else if (type === 'updateMessageContent' || type === 'updateMessageEdited') {
    const chatId = update.chat_id || (update.message ? update.message.chat_id : null);
    const messageId = update.message_id || (update.message ? update.message.id : null);

    if (chatId && messageId) {
      window.tdClient.send({
        '@type': 'getMessage',
        'chat_id': chatId,
        'message_id': messageId
      }).then(msg => handleProviderMessage(msg)).catch(() => {});
    }
  } else if (type === 'updateFile') {
    if (typeof window.handleFileUpdate === 'function') {
        window.handleFileUpdate(update);
    }
  } else if (type === 'updateMessageSendSucceeded') {
    handleProviderMessage(update.message);
  } else if (type === 'updateChatLastMessage') {
    if (update.last_message) {
      handleProviderMessage(update.last_message);
    }
  }
});

async function handleProviderMessage(msg) {
  if (!currentDetailItem || !msg) return;

  // IMMEDIATELY mark as processed to prevent async races
  if (processedMessageIds.has(msg.id)) return;
  processedMessageIds.add(msg.id);

  const stored = localStorage.getItem('sv_extensions');
  const extensions = stored ? JSON.parse(stored) : [];
  let ext = extensions.find(e => String(e.chatId) === String(msg.chat_id));
  const isFileFromPendingBot = pendingFileRequests.has(String(msg.chat_id));

  if (!ext && !isFileFromPendingBot) return;

  if (!ext && isFileFromPendingBot) {
      const pending = pendingFileRequests.get(String(msg.chat_id));
      ext = { title: pending.botUsername ? `@${pending.botUsername}` : "Redirect Bot", chatId: msg.chat_id };
  }

  if (isFileFromPendingBot) {
      console.log(`%c[REDIRECT BOT MESSAGE]`, 'color: #00ff00; font-weight: bold;', {
          msgId: msg.id,
          contentType: msg.content['@type'],
          date: new Date(msg.date * 1000).toISOString()
      });
  }

  const reqs = activeRequests.get(String(msg.chat_id)) || [];
  const isGroup = Number(msg.chat_id) < 0;

  // Strict AFTER_CALLBACK for groups: Only trust if msg is a reply to our click or contains our identity
  let isAfterCallback = (String(msg.chat_id) === String(lastClickedChatId) && (Date.now() - lastClickedTime < 30000));

  if (isAfterCallback && isGroup) {
      const isOurReply = msg.reply_to_message_id && reqs.some(r => r.messageId === msg.reply_to_message_id);
      const myName = (localStorage.getItem('sv_user_name') || "").toLowerCase();
      const contentText = (msg.content?.text?.text || msg.content?.caption?.text || "").toLowerCase();
      const hasMyName = myName && contentText.includes(myName);

      if (!isOurReply && !hasMyName && !isFileFromPendingBot) {
          isAfterCallback = false; // It's just a random message in the group
      }
  }

  let matched = false;
  let matchReason = "";
  let matchedReq = null;

  // Priority 1: Direct Action (Clicks/Redirects) - These are 100% ours
  if (isFileFromPendingBot || isAfterCallback) {
      matched = true;
      matchReason = isFileFromPendingBot ? "PENDING_BOT" : "AFTER_CALLBACK";
      console.log(`[RESULT MATCHED TO REQUEST] (Action: ${matchReason}) Msg ${msg.id} in ${ext.title}`);
  }

  // Strict Identity Data
  const myName = (localStorage.getItem('sv_user_name') || "").toLowerCase();
  const myUsername = (localStorage.getItem('sv_user_username') || "").toLowerCase();

  // Multi-Level Correlation Sieve
  if (!matched && reqs.length > 0) {
      const contentText = (msg.content?.text?.text || msg.content?.caption?.text || "").toLowerCase();
      const buttonText = msg.reply_markup?.rows?.flat().map(b => b.text).join(" ").toLowerCase() || "";
      const fullText = (contentText + " " + buttonText).toLowerCase();
      const normFullText = fullText.replace(/[^a-z0-9\s]/g, ' ');

      // 0. VIRTUAL REQUEST MATCH (Priority for manual clicks)
      const virtualReq = reqs.find(r => r.isVirtual);
      if (virtualReq && (msg.content['@type'] === 'messageVideo' || msg.content['@type'] === 'messageDocument')) {
          matchedReq = virtualReq;
          matched = true;
          matchReason = "VIRTUAL_CLICK";
          console.log(`[CORRELATION VIRTUAL] Msg ${msg.id} matched virtual request for ${matchedReq.title}`);
      }

      // 1. Reply-To Match (Absolute Protocol Link)
      if (!matched && msg.reply_to_message_id) {
          matchedReq = reqs.find(r => r.messageId === msg.reply_to_message_id);
          if (matchedReq) {
              matched = true;
              matchReason = "REPLY";
              console.log(`[CORRELATION REPLY] Msg ${msg.id} matched request ${matchedReq.messageId}`);
          } else {
              console.log(`[CORRELATION REJECTED] Msg ${msg.id} in ${ext.title} replies to someone else (${msg.reply_to_message_id})`);
              return;
          }
      }

      // 2. Name + Query Match (Social Signature)
      if (!matched) {
          const myNameRaw = localStorage.getItem('sv_user_name') || "";
          const myNameTokens = myNameRaw.toLowerCase().split(/\s+/).filter(t => t.length > 0);
          const providerContainsFullName = (myName && fullText.includes(myName));
          const providerContainsUsername = (myUsername && fullText.includes(myUsername));
          const providerMatchedTokens = myNameTokens.filter(token => fullText.includes(token));
          const providerContainsFirstToken = myNameTokens.length > 0 && fullText.includes(myNameTokens[0]);
          const providerContainsAnyToken = providerMatchedTokens.length > 0;

          // FORENSIC VARIABLES (Audit Only)
          const hasFullNameMatch = providerContainsFullName;
          const hasUsernameMatch = providerContainsUsername;
          const hasFirstTokenMatch = providerContainsFirstToken;
          const hasAnyTokenMatch = providerContainsAnyToken;
          const decisionExpression = "(myName && fullText.includes(myName)) || (myUsername && fullText.includes(myUsername))";

          // STRICT IDENTITY LOGIC (As per Audit rules)
          const hasIdentity = (myName && fullText.includes(myName)) || (myUsername && fullText.includes(myUsername)) || hasFirstTokenMatch;
          const ownershipDecision = hasIdentity ? 'ACCEPT' : 'REJECT';

          // RELEVANCE AUDIT LOGGING
          const ENABLE_RELEVANCE_AUDIT = false;

          if (ENABLE_RELEVANCE_AUDIT) {
              console.log('## OWNERSHIP AUDIT');
              console.log('storedNameRaw:', myNameRaw);
              console.log('finalOwnershipBoolean (hasIdentity):', hasIdentity);
              console.log('providerText:', fullText.substring(0, 100) + '...');
              console.log('ownershipDecision:', ownershipDecision);
          }

          if (!hasIdentity) {
              if (ENABLE_RELEVANCE_AUDIT) {
                  console.log('[OWNERSHIP REJECTED] Identity mismatch in group chat.');
              }
          }

          if (hasIdentity) {
              const candidates = [];

              reqs.forEach(r => {
                  const title = r.title.toLowerCase();
                  const year = String(r.year);
                  let candidateAccepted = false;
                  let candidateRejectedReason = "";

                  if (ENABLE_RELEVANCE_AUDIT) {
                      console.log('--- CANDIDATE AUDIT ---', r.title);
                  }

                  // Qualification: Content Check (Year for Movies, Episode for TV)
                  const isEpisodeReq = !!(r.season && r.episode);

                  if (isEpisodeReq) {
                      const detected = window.parseEpisodeContext(fullText);
                      const seasonMatch = detected && detected.season === r.season;
                      const episodeMatch = detected && detected.episode === r.episode;

                      if (!detected) {
                          candidateRejectedReason = "EPISODE_CONTEXT_NOT_DETECTED";
                      } else if (!seasonMatch || !episodeMatch) {
                          candidateRejectedReason = "EPISODE_OR_SEASON_MISMATCH";
                      }

                      if (!episodeMatch || !seasonMatch) {
                          if (ENABLE_RELEVANCE_AUDIT) console.log('candidateRejectedReason:', candidateRejectedReason);
                          return;
                      }
                      console.log(`[EPISODE MATCH] title="${r.title}" S${r.season}E${r.episode}`);
                  } else {
                      // Movie qualification: Year match
                      const yearMatch = year && year !== "undefined" && fullText.includes(year);
                      if (!yearMatch) return;
                  }

                  // Qualification: 100% Token Coverage
                  const tokens = title.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 0);
                  const allTokensPresent = tokens.every(t => normFullText.includes(t));

                  if (allTokensPresent) {
                      const score = tokens.length;
                      candidateAccepted = true;
                      candidates.push({ req: r, score });
                      if (ENABLE_RELEVANCE_AUDIT) console.log(`[CORRELATION CANDIDATE] requestTitle="${r.title}" score=${score}`);
                  }
              });

              if (candidates.length > 0) {
                  // Sort by highest score, then newest timestamp
                  candidates.sort((a, b) => {
                      if (b.score !== a.score) return b.score - a.score;
                      return b.req.timestamp - a.req.timestamp;
                  });

                  if (ENABLE_RELEVANCE_AUDIT) console.log('bestCandidate:', candidates[0].req.title);

                  matchedReq = candidates[0].req;
                  matched = true;
                  matchReason = "NAME_QUERY";
                  console.log(`[CORRELATION WINNER] requestTitle="${matchedReq.title}" score=${candidates[0].score}`);
              }
          }
      }

      // 3. Private Chat Fallback (Implicit Ownership)
      if (!matched && Number(msg.chat_id) > 0) {
          const candidates = [];

          reqs.forEach(r => {
              const title = r.title.toLowerCase();
              const tokens = title.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 0);

              if (tokens.every(t => normFullText.includes(t))) {
                  const score = tokens.length;
                  candidates.push({ req: r, score });
              }
          });

          if (candidates.length > 0) {
              candidates.sort((a, b) => {
                  if (b.score !== a.score) return b.score - a.score;
                  return b.req.timestamp - a.req.timestamp;
              });
              matchedReq = candidates[0].req;
              matched = true;
              matchReason = "PRIVATE_FALLBACK";
              console.log(`[CORRELATION PRIVATE_FALLBACK] Msg ${msg.id} matched in private chat for ${matchedReq.title} score=${candidates[0].score}`);
          }
      }
      console.log('------------------------------');
  }

  if (!matched) {
      if (msg.reply_markup || (msg.content && msg.content['@type'] === 'messageVideo')) {
          const reason = reqs.length === 0 ? "NO_ACTIVE_REQUESTS" : "IDENTITY_OR_CONTEXT_MISMATCH";
          console.log(`[CORRELATION REJECTED] Msg ${msg.id} in ${ext.title} reason=${reason}`);
      }
      return;
  }

  // --- SESSION ISOLATION CHECK ---
  const sessionId = matchedReq ? matchedReq.sessionId : null;

  if (sessionId && sessionId !== currentSearchSessionId) {
      console.log(`[SESSION REJECTED]\nold=${sessionId}\ncurrent=${currentSearchSessionId}`);
      return;
  }

  // PHASE 7A: PAGINATION-AWARE RETENTION
  // Requests are no longer removed after the first match.
  // They persist to allow Page 2, Page 3, and Redirect Bot responses to correlate.
  if (matchedReq) {
      console.log(`[PAGINATION ACTIVE] Request for ${matchedReq.title} remains in registry for further pages/callbacks.`);
  }

  if (isFileFromPendingBot) {
      console.log(`[FILE RECEIVED FROM REDIRECT BOT] Received message from target bot ${msg.chat_id}`);
      const pending = pendingFileRequests.get(String(msg.chat_id));
      if (pending && pending.sourceId) {
          console.log(`[MATCHED TO CLICKED SOURCE] ${pending.sourceId}`);
      }
  }

  if (msg.content && msg.content.text) {
      if (msg.content.text.text.toLowerCase().includes("join")) {
          document.getElementById("sourceStatus").textContent = `Bot @${ext.title} says: ${msg.content.text.text.substring(0, 50)}...`;
      }
  }
  await processMessageContent(msg, ext, isAfterCallback || isFileFromPendingBot);
}

function findPaginationIndicator(msg) {
    const regex = /(\d+)\s*\/\s*(\d+)/;
    const contentText = (msg.content?.text?.text || msg.content?.caption?.text || "");
    const textMatch = contentText.match(regex);
    if (textMatch) {
        return { currentPage: parseInt(textMatch[1]), maxPage: parseInt(textMatch[2]), source: "message" };
    }
    if (msg.reply_markup && msg.reply_markup.rows) {
        for (const row of msg.reply_markup.rows) {
            for (const button of row) {
                const btnMatch = button.text.match(regex);
                if (btnMatch) {
                    return { currentPage: parseInt(btnMatch[1]), maxPage: parseInt(btnMatch[2]), source: "button" };
                }
            }
        }
    }
    return null;
}

async function processMessageContent(msg, ext, isAfterCallback = false) {
  const c = msg.content;
  const isFileFromPendingBot = pendingFileRequests.has(String(msg.chat_id));

  if (isFileFromPendingBot) {
      console.log(`%c[REDIRECT FILE RECEIVED]`, 'color: #00ff00; font-weight: bold;', { msgId: msg.id, chatId: msg.chat_id });
  }

  let file = null;
  let fileName = "";
  let mediaType = "";

  if (c.video) { file = c.video.video; fileName = c.video.file_name; mediaType = "VIDEO"; }
  else if (c.document) { file = c.document.document; fileName = c.document.file_name; mediaType = "DOCUMENT"; }
  else if (c.animation) { file = c.animation.animation; fileName = c.animation.file_name; mediaType = "ANIMATION"; }
  else if (c.audio) { file = c.audio.audio; fileName = c.audio.file_name; mediaType = "AUDIO"; }

  if (file) {
    if (isFileFromPendingBot) {
        console.log(`%c[REDIRECT MEDIA TYPE]`, 'color: #00ff00;', mediaType);
        console.log(`%c[FILE ID EXTRACTED]`, 'color: #00ff00;', file.id);
    }

    if (!fileName) fileName = "media_file";

    // LENIENCE: If it's a file from a pending bot request, we skip validation/relevance
    // checks initially because we asked for it explicitly.
    if (!isValidVideoFile(fileName, file.size) && !isAfterCallback && !isFileFromPendingBot) return;

    const relResult = await isRelevant(fileName, currentDetailItem);
    const finalDec = relResult || isAfterCallback || isFileFromPendingBot;

    // --- SOURCE CREATION AUDIT (FILE) ---
    const detected = window.parseEpisodeContext(fileName);
    const epMatch = detected && currentDetailItem.season && currentDetailItem.episode &&
                    detected.season === currentDetailItem.season &&
                    detected.episode === currentDetailItem.episode;

    console.log('--- SOURCE CREATION AUDIT ---');
    console.log('sourceTitle:', fileName);
    console.log('creationPath: processMessageContent (Direct File)');
    console.log('episodeMatch:', !!epMatch);
    console.log('isRelevant:', relResult);
    console.log('isAfterCallback:', isAfterCallback);
    console.log('finalDecision:', finalDec);
    console.log('------------------------------------');

    if (finalDec) {
      console.log(`[FILE MESSAGE RECEIVED] ${fileName}`);
      const pending = pendingFileRequests.get(String(msg.chat_id));

      if (pending && pending.sourceId) {
          const originalSource = window.currentSources.find(s => s.uniqueId === pending.sourceId);
          if (originalSource) {
              console.log(`[UPDATING ORIGINAL SOURCE] ${pending.sourceId}`);

              originalSource.fileId = file.id;
              originalSource.uniqueId = file.remote.unique_id;
              originalSource.remoteId = file.remote.id;
              originalSource.botChatId = String(msg.chat_id);
              originalSource.messageId = msg.id;
              originalSource.itemId = msg.id;
              originalSource.isButton = false;

              let intentMatched = false;
              if (pendingDownloadRequest) {
                  const waitTime = Date.now() - pendingDownloadRequest.clickedAt;
                  if (waitTime < 120000) {
                      if (originalSource.startParameter && pendingDownloadRequest.startParameter === originalSource.startParameter) intentMatched = true;
                      else if (pendingDownloadRequest.uniqueId === pending.sourceId) intentMatched = true;
                      else if (String(msg.chat_id) === String(pendingDownloadRequest.chatId)) intentMatched = true;
                  }
              }
              const isAuto = intentMatched || autoDownloadUniqueId === pending.sourceId || (originalSource.startParameter && autoDownloadUniqueId === originalSource.startParameter);

              if (isFileFromPendingBot) {
                  console.log(`%c[AUTO DOWNLOAD DECISION]`, 'color: #00ff00; font-weight: bold;', { isAuto, intentMatched, waitTime: pendingDownloadRequest ? (Date.now() - pendingDownloadRequest.clickedAt) : 'N/A' });
                  if (!isAuto) {
                      console.log('%c[AUTO DOWNLOAD BLOCKED]', 'color: #ff0000; font-weight: bold;', {
                          hasPendingDownloadRequest: !!pendingDownloadRequest,
                          pdrUniqueId: pendingDownloadRequest?.uniqueId,
                          pendingSourceId: pending?.sourceId,
                          pdrChatId: pendingDownloadRequest?.chatId,
                          msgChatId: msg.chat_id
                      });
                  }
              }

              if (isAuto) {
                  console.log(`[FILE RECEIVED DURING WAIT] ${fileName}`);
                  const wasPlayback = pendingDownloadRequest && pendingDownloadRequest.isPlayback;
                  autoDownloadUniqueId = null;
                  const capturedHandle = pendingDownloadRequest?.handle;
                  pendingDownloadRequest = null;

                  if (wasPlayback) {
                      console.log(`%c[PLAYBACK START INVOKED]`, 'color: #00ff00; font-weight: bold;', fileName);
                      if (typeof openPlayer === 'function') {
                          openPlayer(originalSource);
                      }
                  } else {
                      console.log(`%c[DOWNLOAD START INVOKED]`, 'color: #00ff00; font-weight: bold;', fileName);
                      if (typeof startDownload === 'function') {
                          startDownload(file.id, msg.id, fileName, false, msg.chat_id, capturedHandle, originalSource.uniqueId, 0, 0, originalSource.startParameter);
                      }
                  }
              }

              await cacheSource(originalSource);
              renderMovieSources(window.currentSources);
              pendingFileRequests.delete(String(msg.chat_id));
              return;
          }
      }

      const startParam = isAfterCallback ? lastStartParam : (pending ? pending.startParam : null);
      const source = {
        uniqueId: file.remote.unique_id,
        remoteId: file.remote.id,
        fileId: file.id,
        fileName: fileName,
        size: file.size,
        addon: ext.title,
        addonId: msg.chat_id,
        itemId: msg.id,
        movieTitle: currentDetailItem.title || currentDetailItem.label,
        movieYear: currentDetailItem.year,
        botUsername: isAfterCallback ? lastBotUsername : (pending ? pending.botUsername : null),
        startParam: startParam,
        startParameter: startParam
      };

      console.log(`[FILE OBJECT FOUND] ID: ${file.id}, Unique: ${file.remote.unique_id}`);

      // ─── DOWNLOAD ON FIRST CLICK ───
      let intentMatched = false;
      if (pendingDownloadRequest) {
          const waitTime = Date.now() - pendingDownloadRequest.clickedAt;
          if (waitTime < 120000) {
              if (source.startParameter && pendingDownloadRequest.startParameter === source.startParameter) intentMatched = true;
              else if (source.uniqueId === pendingDownloadRequest.uniqueId) intentMatched = true;
              else if (String(msg.chat_id) === String(pendingDownloadRequest.chatId)) intentMatched = true;
          }
      }

      const isAuto = intentMatched || autoDownloadUniqueId === source.uniqueId || (source.startParameter && autoDownloadUniqueId === source.startParameter);

      if (isFileFromPendingBot) {
          console.log(`%c[AUTO DOWNLOAD DECISION]`, 'color: #00ff00; font-weight: bold;', { isAuto, intentMatched });
          if (!isAuto) {
              console.log('%c[AUTO DOWNLOAD BLOCKED]', 'color: #ff0000; font-weight: bold;', {
                  hasPendingDownloadRequest: !!pendingDownloadRequest,
                  pdrChatId: pendingDownloadRequest?.chatId,
                  msgChatId: msg.chat_id
              });
          }
      }

      if (isAuto) {
          const wasPlayback = pendingDownloadRequest && pendingDownloadRequest.isPlayback;
          autoDownloadUniqueId = null;
          const capturedHandle = pendingDownloadRequest?.handle;
          pendingDownloadRequest = null;

          if (wasPlayback) {
              console.log(`%c[PLAYBACK START INVOKED]`, 'color: #00ff00; font-weight: bold;', fileName);
              if (typeof openPlayer === 'function') {
                  openPlayer(source);
              }
          } else {
              console.log(`%c[DOWNLOAD START INVOKED]`, 'color: #00ff00; font-weight: bold;', fileName);
              if (typeof startDownload === 'function') {
                  startDownload(source.fileId, source.itemId, source.fileName, false, msg.chat_id, capturedHandle, source.uniqueId, 0, 0, source.startParameter);
              }
          }
      }

      await cacheSource(source);
      addSourceToUI(source);
    } else {
      console.log(`[FILTERED] Irrelevant file: ${fileName}`);
    }
  }

// Pagination state tracking
// Moved to global scope at top of file

  // Handle Inline Buttons (Metadata Extraction & Crawling)
  if (msg.reply_markup && msg.reply_markup['@type'] === 'replyMarkupInlineKeyboard') {

    await extractSourcesFromButtons(msg, ext);

    const pagination = findPaginationIndicator(msg);
    const currentPage = pagination ? pagination.currentPage : 1;
    const maxPage = pagination ? pagination.maxPage : 1;

    if (pagination) {
        console.log(`[PAGINATION SOURCE]\n${pagination.source}`);
    }

    const cid = String(msg.chat_id);
    const highest = highestPageReached.get(cid) || 0;
    if (currentPage > highest) highestPageReached.set(cid, currentPage);
    const currentHighest = highestPageReached.get(cid);

    console.log(`[PAGINATION STATE] currentPage=${currentPage} maxPage=${maxPage} highestPageReached=${currentHighest}`);

    const allButtons = msg.reply_markup.rows.flat().filter(b => b.type['@type'] === 'inlineKeyboardButtonTypeCallback');
    const navButtons = allButtons.filter(b => isNavigationButton(b.text));

    const isFileFromPendingBot = pendingFileRequests.has(String(msg.chat_id));
    const isGroup = Number(msg.chat_id) < 0;

    // HARVEST PASS LOGIC:
    // In groups: ONLY click navigation. Clicking files triggers redirects/spam.
    // In private bots: Click files/play buttons to get the direct file link.
    const fileButtons = isGroup ? [] : allButtons.filter(b => isMovieFileButton(b.text) || isFileFromPendingBot);

    // PHASE 8: PASS 1 – DISCOVERY (Navigation Priority)
    if (navButtons.length > 0 && currentPage < maxPage) {
        console.log(`[NAVIGATION PASS] Analyzing navigation from page ${currentPage}/${maxPage}`);
        for (const button of navButtons) {
            const btnText = button.text.toUpperCase();
            const btnKey = `${msg.chat_id}_${msg.id}_${button.type.data}`;

            // 1. Identify Direction
            const isBackward = btnText.includes('PREVIOUS') || btnText.includes('BACK') || btnText.includes('PREV') || btnText.includes('<<<') || btnText.includes('<<');
            const direction = isBackward ? 'BACKWARD' : 'FORWARD';

            // 2. Estimate Target Page (Heuristic)
            let targetPage = currentPage + (isBackward ? -1 : 1);
            const numMatch = button.text.match(/\b(\d+)\b/);
            if (numMatch) targetPage = parseInt(numMatch[1]);

            console.log(`[NAVIGATION CANDIDATE] button="${button.text}" direction=${direction} targetPage=${targetPage}`);

            // 3. Forward-Only Enforcement
            if (isBackward || targetPage <= currentHighest) {
                console.log(`[NAVIGATION SKIPPED] reason=BACKTRACK targetPage=${targetPage} highest=${currentHighest}`);
                continue;
            }

            if (!processedButtons.has(btnKey)) {
                processedButtons.add(btnKey);
                console.log(`[NAVIGATION ACCEPTED] targetPage=${targetPage}`);
                console.log(`[PAGINATION CLICK] Executing priority navigation: "${button.text}"`);
                await crawlCallback(msg.chat_id, msg.id, button.type.data, button.text, false);
            }
        }
    } else if (currentPage >= maxPage) {
        console.log(`[DISCOVERY COMPLETE] Final page reached: ${currentPage}/${maxPage}`);
    }

    // PHASE 8: PASS 2 – HARVEST (File Callbacks)
    // Only enabled for private chats (bots) to avoid polluting group chats or invalidating group redirects
    if (!isGroup && fileButtons.length > 0) {
        console.log(`[HARVEST PASS] Harvesting file callbacks in private chat.`);
        for (const button of fileButtons) {
            const btnKey = `${msg.chat_id}_${msg.id}_${button.type.data}`;

            // SECURITY: Skip direct file# callbacks in discovery harvesting to prevent bot anti-spam/invalidation
            // UNLESS it's from a redirect bot, then we might need to click it to get the file.
            let decoded = "";
            try { decoded = atob(button.type.data); } catch (e) { decoded = button.type.data; }
            const isFileCallback = typeof decoded === 'string' && decoded.startsWith("file#");

            if (isFileCallback && !isFileFromPendingBot) continue;

            if (!processedButtons.has(btnKey)) {
                processedButtons.add(btnKey);
                console.log(`[CALLBACK ACTIVE] Dispatching harvest task for: ${button.text}`);
                await crawlCallback(msg.chat_id, msg.id, button.type.data, button.text, false);
            }
        }
    }
  }
}

async function extractSourcesFromButtons(msg, ext, isForcedFallback = false) {
  if (!msg.reply_markup || msg.reply_markup['@type'] !== 'replyMarkupInlineKeyboard') return;

  for (const row of msg.reply_markup.rows) {
    for (const button of row) {
      if (button.type['@type'] === 'inlineKeyboardButtonTypeCallback') {
        const text = button.text;
        const data = button.type.data;

        let decoded = "";
        try { decoded = atob(data); } catch (e) { decoded = data; }

        const sizeMatch = text.match(/(\d+(?:\.\d+)?)\s*(GB|MB|KB|B)/i);
        const isFileCallback = typeof decoded === 'string' && decoded.startsWith("file#");

        const relResult = await isRelevant(text, currentDetailItem);

        // Leniency for redirect bots: If it's from a bot we were redirected to, we accept buttons even if they don't look like file buttons (e.g. "🎬 Play Movie 🎬").
        const isFileFromPendingBot = pendingFileRequests.has(String(msg.chat_id));

        // MANDATORY RELEVANCE: All sources, including file# callbacks, must pass heuristics.
        const finalBtnDecision = (relResult || isFileFromPendingBot) && (isFileCallback || isMovieFileButton(text) || isFileFromPendingBot);

        // --- SOURCE CREATION AUDIT (BUTTON) ---
        const detected = window.parseEpisodeContext(text);
        const epMatch = detected && currentDetailItem.season && currentDetailItem.episode &&
                        detected.season === currentDetailItem.season &&
                        detected.episode === currentDetailItem.episode;

        console.log('--- SOURCE CREATION AUDIT ---');
        console.log('sourceTitle:', text);
        console.log('isFileCallback:', isFileCallback);
        console.log('episodeMatch:', !!epMatch);
        console.log('isRelevant:', relResult);
        console.log('finalDecision:', finalBtnDecision);
        console.log('-----------------------------');

        if (finalBtnDecision) {
          let size = 0;
          if (sizeMatch) {
            const val = parseFloat(sizeMatch[1]);
            const unit = sizeMatch[2].toUpperCase();
            size = val * (unit === 'GB' ? 1073741824 : unit === 'MB' ? 1048576 : unit === 'KB' ? 1024 : 1);
          }

          if (!isValidVideoFile(text, size)) {
            console.log(`[SKIPPED] Not a valid video file format: ${text}`);
            continue;
          }

          let telegramFileId = null;
          if (isFileCallback) telegramFileId = decoded.substring(5);

          // Identify Bot ID from sender if it's a group
          let senderBotId = null;
          if (msg.sender_id && msg.sender_id['@type'] === 'messageSenderUser') {
              senderBotId = msg.sender_id.user_id;
          }

          const source = {
            uniqueId: isFileCallback ? `file_${telegramFileId}` : `btn_${msg.chat_id}_${msg.id}_${data}`,
            fileName: text,
            size: size,
            addon: ext.title,
            addonId: msg.chat_id,
            itemId: msg.id,
            callbackData: data,
            isButton: true,
            telegramFileId: telegramFileId,
            movieTitle: currentDetailItem.title || currentDetailItem.label,
            movieYear: currentDetailItem.year,
            // Chain Tracking
            providerGroup: msg.chat_id,
            keyboardMessageId: msg.id,
            sourceTitle: text,
            sourceQuality: detectQuality(text),
            // RECOVERY FIX: Store the bot ID and sender ID
            viaBotId: msg.via_bot_user_id !== 0 ? msg.via_bot_user_id : null,
            senderBotId: senderBotId
          };

          console.log(`[SOURCE ACCEPTED] Dispatching to UI: ${text}`);
          addSourceToUI(source);
        }
      }
    }
  }
}

async function crawlCallback(chatId, messageId, data, buttonText = "Unknown", isUserClick = false) {
  const timestamp = Date.now();
  console.log('[CALLBACK AUDIT] crawlCallback initialized:', {
    chatId,
    messageId,
    callbackData: data,
    timestamp
  });

  try {
    if (isUserClick) {
        lastClickedChatId = chatId;
        lastClickedTime = Date.now();
    }

    const res = await window.tdClient.send({
      '@type': 'getCallbackQueryAnswer',
      'chat_id': chatId,
      'message_id': messageId,
      'payload': { '@type': 'callbackQueryPayloadData', 'data': data }
    });

    if (res.url) {
      try {
        const urlObj = new URL(res.url);
        let botUsername = "";
        if (urlObj.hostname === "t.me" || urlObj.hostname === "telegram.me") {
          botUsername = urlObj.pathname.split('/')[1];
        }

        const startParam = urlObj.searchParams.get('start');

        if (botUsername && startParam) {
           console.log(`[REDIRECT BOT DETECTED] @${botUsername}`);
           console.log(`[START PARAMETER EXTRACTED] ${startParam}`);

           const chat = await window.tdClient.send({ '@type': 'searchPublicChat', 'username': botUsername });
           console.log(`[BOT RESOLVED] @${botUsername} -> ${chat.id}`);

           // Chain Tracking & Update Source
           const source = window.currentSources.find(s => String(s.addonId) === String(chatId) && String(s.itemId) === String(messageId) && s.callbackData === data);
           if (source) {
               source.redirectBot = botUsername;
               source.startParameter = startParam;
               source.redirectBotChatId = String(chat.id);
               source.providerGroup = chatId;
               source.keyboardMessageId = messageId;
           }

           if (isUserClick) {
               lastBotUsername = botUsername;
               lastStartParam = startParam;

               console.log(`%c[USER REDIRECT] Following redirect to @${botUsername}`, 'color: #00ff00; font-weight: bold;');

               // Update pendingDownloadRequest chatId to the bot so the auto-download matches
               if (pendingDownloadRequest && (String(pendingDownloadRequest.chatId) === String(chatId))) {
                   pendingDownloadRequest.chatId = String(chat.id);
                   console.log(`[PENDING REQUEST UPDATED] Target Chat ID shifted to Bot: ${chat.id}`);
               }

               await window.tdClient.send({
                   '@type': 'sendBotStartMessage',
                   'bot_user_id': chat.id,
                   'chat_id': chat.id,
                   'parameter': startParam
               }).catch(async (e) => {
                   console.log(`[REDIRECT BOT FALLBACK] sendBotStartMessage failed, sending text /start`, e);
                   await window.tdClient.send({
                       '@type': 'sendMessage',
                       'chat_id': chat.id,
                       'input_message_content': {
                           '@type': 'inputMessageText',
                           'text': { '@type': 'formattedText', 'text': `/start ${startParam}` }
                       }
                   });
               });
           }

           pendingFileRequests.set(String(chat.id), {
               startParam: startParam,
               botUsername: botUsername,
               timestamp: Date.now(),
               sourceId: source ? source.uniqueId : null
           });

           if (isUserClick) {
               lastClickedChatId = chat.id;
               lastClickedTime = Date.now();
           }
        }
      } catch (e) {}
    }

    setTimeout(async () => {
      const checkId = isUserClick && lastClickedChatId ? lastClickedChatId : chatId;
      if (lastClickedChatId === checkId && (Date.now() - lastClickedTime >= 12000)) {
        try {
          const msg = await window.tdClient.send({ '@type': 'getMessage', 'chat_id': chatId, 'message_id': messageId });
          const stored = localStorage.getItem('sv_extensions');
          const extensions = stored ? JSON.parse(stored) : [];
          const ext = extensions.find(e => String(e.chatId) === String(chatId));
          if (ext) await extractSourcesFromButtons(msg, ext, true);
        } catch (e) {}
      }
    }, 12000);

  } catch (e) {
    if (e.message && e.message.includes("DATA_INVALID")) {
      try {
        const msg = await window.tdClient.send({ '@type': 'getMessage', 'chat_id': chatId, 'message_id': messageId });
        if (msg.reply_markup && msg.reply_markup['@type'] === 'replyMarkupInlineKeyboard') {
           const stillExists = msg.reply_markup.rows.some(row => row.some(b => b.type.data === data));
           if (!stillExists) console.log("[KEYBOARD CHANGED] Callback data is no longer present");
        }
      } catch (ge) {}
    }
  }
}

// Heuristics moved to js/logic/heuristics.js
function isMovieFileButton(t) {
    try {
        return window.Heuristics && typeof window.Heuristics.isMovieFileButton === 'function' ? window.Heuristics.isMovieFileButton(t) : false;
    } catch(e) { return false; }
}
function isNavigationButton(t) {
    try {
        return window.Heuristics && typeof window.Heuristics.isNavigationButton === 'function' ? window.Heuristics.isNavigationButton(t) : false;
    } catch(e) { return false; }
}
async function isRelevant(f, i) {
    try {
        return window.Heuristics && typeof window.Heuristics.isRelevant === 'function' ? await window.Heuristics.isRelevant(f, i) : false;
    } catch(e) { return false; }
}

function updateFilterDropdown() {
    const filterDropdown = document.getElementById("sourceFilter");
    if (!filterDropdown) return;
    const currentVal = filterDropdown.value;

    let html = `<option value="all">All Sources (${window.currentSources.length})</option>`;
    providerStates.forEach((state, cid) => {
        const shortName = shortenProviderName(state.title);
        html += `<option value="${cid}">${shortName} (${state.count})</option>`;
    });

    filterDropdown.innerHTML = html;
    filterDropdown.value = currentVal;
}

function filterSources() {
    const filterDropdown = document.getElementById("sourceFilter");
    if (!filterDropdown) return;
    window.selectedFilter = filterDropdown.value;
    renderMovieSources(window.currentSources);
    console.log(`[FILTER UPDATED] Selected: ${window.selectedFilter}`);
}

function addSourceToUI(source, isCacheLoad = false) {
  const cid = String(source.addonId);
  const state = providerStates.get(cid);

  if (isCacheLoad) source.fromCache = true;

  if (state && state.count >= 20 && !isCacheLoad) return;

  // 1. Generate StreamVault Keys
  let lookupToken = source.startParameter || source.startParam;
  if (!lookupToken && source.callbackData) {
      let decoded = "";
      try { decoded = atob(source.callbackData); } catch (e) { decoded = source.callbackData; }
      if (typeof decoded === 'string' && decoded.startsWith("file#")) {
          lookupToken = decoded.replace("file#", "file_");
      }
  }
  if (!lookupToken && source.telegramFileId) {
      lookupToken = `file_${source.telegramFileId}`;
  }

  const taskIdentity = window.getTaskIdentity(source.addonId, lookupToken);
  const fingerprint = source.fileName && source.size ? `${source.fileName}_${source.size}` : null;

  const manager = window.downloadManager;
  const existingTask = manager ? (
                       (lookupToken ? manager.get(String(lookupToken)) : null) ||
                       (taskIdentity ? manager.get(taskIdentity) : null) ||
                       (source.uniqueId ? manager.get(String(source.uniqueId)) : null) ||
                       (fingerprint ? manager.get(fingerprint) : null)
  ) : null;

  if (existingTask) {
      console.log(`[IDENTITY ADOPTION] Matching search result to existing task: ${source.fileName}`);
      if (existingTask.telegram) {
          if (existingTask.telegram.telegramUniqueId) source.uniqueId = existingTask.telegram.telegramUniqueId;
          if (existingTask.telegram.fileId) source.fileId = existingTask.telegram.fileId;
      }
      source.taskId = existingTask.taskId;
  }

  source.lookup = {
      providerId: source.addonId,
      lookupToken: lookupToken,
      taskIdentity: taskIdentity,
      taskId: source.taskId || null
  };

  const normNew = normalizeFileName(source.fileName);
  let existingIdx = window.currentSources.findIndex(s => {
    if (s.uniqueId && source.uniqueId && s.uniqueId === source.uniqueId) return true;
    if (s.startParameter && source.startParameter && s.startParameter === source.startParameter) return true;
    const normOld = normalizeFileName(s.fileName);
    return (normOld === normNew && s.size === source.size);
  });

  if (existingIdx !== -1) {
    const existing = window.currentSources[existingIdx];
    const score = (s) => (s.fileId ? 1000 : 0) + (!s.fromCache ? 5000 : 0) + (s.size || 0);

    if (score(source) > score(existing)) {
      const updated = { ...existing, ...source };
      if (!source.fromCache) delete updated.fromCache;
      window.currentSources[existingIdx] = updated;
      renderMovieSources(window.currentSources);
    }
    return;
  }

  window.currentSources.push(source);
  if (state) state.count++;

  updateFilterDropdown();

  if (!window.selectedFilter || window.selectedFilter === "all" || window.selectedFilter === cid) {
      renderMovieSources(window.currentSources);
  }
}

// detectQuality and normalizeFileName moved to js/utils/format.js
// renderMovieSources moved to js/sources/ui.js

window.playSelectedSource = function() {
    if (!window.selectedSource) {
        alert("Please select a source first");
        return;
    }
    handleSourceClick(window.selectedSource, true);
};

window.downloadSelectedSource = async function() {
    if (!window.selectedSource) {
        alert("Please select a source first");
        return;
    }

    const uniqueId = window.selectedSource.uniqueId;
    const fileId = window.selectedSource.fileId;
    const taskId = window.selectedSource.taskId;
    const lookup = window.selectedSource.lookup || {};

    const entry = (taskId ? window.downloadManager.get(taskId) : null) ||
                  (lookup.lookupToken ? window.downloadManager.get(String(lookup.lookupToken)) : null) ||
                  (uniqueId && window.downloadManager.get(String(uniqueId))) ||
                  (fileId && window.downloadManager.get(String(fileId)));

    if (entry && entry.progress.state === 'completed' && entry.progress.savePath) {
        const fileExists = await window.electronAPI.verifyAndResumeFile({
            fileId: entry.telegram.fileId,
            savePath: entry.progress.savePath,
            lastOffset: 0
        });

        if (fileExists.success) {
            console.log('[DOWNLOAD BUTTON] File is local and completed. Playing...');
            if (typeof openPlayer === 'function') {
                openPlayer(window.selectedSource);
                return;
            }
        } else {
            console.warn('[DOWNLOAD BUTTON] File marked completed but missing on disk. Re-resolving...');
            entry.progress.state = 'paused';
            entry.progress.networkBytes = 0;
        }
    }

    const needsResolution = !entry || entry.progress.state === 'error' || (entry.progress.networkBytes === 0 && entry.progress.state !== 'downloading');

    if (entry && !needsResolution) {
        console.log('[DOWNLOAD BUTTON] Toggling state for:', window.selectedSource.fileName);
        window.toggleDownload(entry.telegram.fileId, entry.discovery.messageId);
    } else {
        console.log('[DOWNLOAD BUTTON] Starting resolution flow:', window.selectedSource.fileName);
        handleSourceClick(window.selectedSource, false);
    }
};

window.handleSourceClick = handleSourceClick;

async function handleSourceClick(source, isPlayback = false) {
    const timestamp = Date.now();
    console.log(`[CALLBACK AUDIT] handleSourceClick started:`, {
        fileName: source.fileName,
        fileId: source.fileId,
        chatId: source.addonId,
        messageId: source.itemId,
        hasCallback: !!source.callbackData,
        hasStartParam: !!(source.startParameter || source.startParam),
        timestamp
    });

    PersistentLogger.log('SOURCE CLICK', { fileName: source.fileName, isPlayback });

    // Capture File Handle EARLY while gesture is fresh
    let capturedHandle = null;
    if (!isPlayback && window.showSaveFilePicker && !window.electronAPI) {
        try {
            PersistentLogger.log('EARLY PICKER OPEN');
            capturedHandle = await window.showSaveFilePicker({ suggestedName: source.fileName });
            PersistentLogger.log('EARLY PICKER SELECTED', { name: capturedHandle.name });
        } catch (e) {
            PersistentLogger.log('EARLY PICKER SKIPPED/CANCELLED', { error: String(e) });
            if (e.name === 'AbortError') return;
        }
    }

    if (source.fromCache) console.log('[CACHE SOURCE]', source.fileName);
    if (source.fileId) console.log('[HAS FILEID]', source.fileId);
    if (source.callbackData) console.log('[HAS CALLBACKDATA]', source.callbackData);
    if (source.startParameter || source.startParam) console.log('[HAS STARTPARAM]', source.startParameter || source.startParam);

    // Track intent for when/if a fresh file arrives
    pendingDownloadRequest = {
        uniqueId: source.uniqueId,
        startParameter: source.startParameter || source.startParam,
        fileName: source.fileName,
        chatId: source.addonId,
        clickedAt: Date.now(),
        isPlayback: isPlayback,
        handle: capturedHandle
    };
    PersistentLogger.log('PENDING REQUEST CREATED', { uniqueId: source.uniqueId });
    console.log(`[PENDING REQUEST CREATED] ${source.fileName}`);
    PersistentLogger.log('WAITING FOR FILE');
    console.log(`[WAITING FOR FILE]`);

    const canRegenerate = !!(source.callbackData || source.startParameter || source.startParam);

    // STEP 1: Direct Download/Stream ONLY if no regeneration path exists
    if (source.fileId && !canRegenerate) {
        console.log(`[FILE ID FOUND] ${source.fileId}`);
        if (isPlayback) {
            console.log(`[PLAYBACK USING CACHED FILE] ${source.fileId}`);
            console.log(`[STARTING DIRECT PLAYBACK] ${source.fileName}`);
            if (typeof openPlayer === 'function') {
                openPlayer(source);
                return;
            }
        } else {
            console.log(`[STARTING DIRECT DOWNLOAD] ${source.fileName}`);
            if (typeof startDownload === 'function') {
                const lookupToken = source.startParameter || source.startParam || (source.telegramFileId ? `file_${source.telegramFileId}` : null);
                startDownload(source.fileId, source.itemId, source.fileName, false, source.botChatId || source.addonId, capturedHandle, null, 0, 0, lookupToken);
                return;
            }
        }
    }

    if (canRegenerate) {
        console.log('[FORCING CALLBACK/REGEN FLOW]');
    }

    // STEP 2: Regenerate if fileId is missing or if we have a callback path
    console.log(`[FILE ID MISSING OR BYPASSED FOR REGEN]`);
    if (isPlayback) console.log(`[PLAYBACK WAITING FOR BOT RESPONSE]`);
    console.log(`[REGENERATING FROM BOT] ${source.fileName}`);

    // --- CACHE RECOVERY & SAFE REGEN (FINAL FIX) ---
    // If we have callbackData but no startParam, and it's a file# link, recover it.
    let effectiveStartParam = source.startParameter || source.startParam;
    if (!effectiveStartParam && source.callbackData) {
        let decoded = "";
        try { decoded = atob(source.callbackData); } catch (e) { decoded = source.callbackData; }
        if (typeof decoded === 'string' && decoded.startsWith("file#")) {
            effectiveStartParam = decoded.replace("file#", "file_");
            console.log(`[RECOVERED START PARAM] ${effectiveStartParam}`);
        }
    }

    if (source.isButton || !source.fileId || canRegenerate || effectiveStartParam) {
        // If we have a start parameter, always try to send it to the bot to "ask" for the file
        if (effectiveStartParam) {
            // RECOVERY: Ensure we have a numeric targetBotId.
            // 1. Check if we have a recorded 'viaBotId' or 'senderBotId'
            // 2. Check if we have a 'redirectBotChatId'
            // 3. If we have a username (redirectBot or botUsername), resolve it first.
            let targetBotId = source.viaBotId || source.senderBotId || source.redirectBotChatId;

            const botUsernameToResolve = source.redirectBot || source.botUsername || (source.addon && source.addon.startsWith('@') ? source.addon.substring(1) : null);

            if ((!targetBotId || targetBotId === '0' || Number(targetBotId) < 0) && botUsernameToResolve) {
                console.log(`[RECOVERY] Attempting to resolve Bot ID via username: @${botUsernameToResolve}`);
                try {
                    const chat = await window.tdClient.send({ '@type': 'searchPublicChat', 'username': botUsernameToResolve });
                    if (chat && chat.id) {
                        targetBotId = String(chat.id);
                        source.redirectBotChatId = targetBotId;
                        console.log(`[RECOVERY SUCCESS] Resolved @${botUsernameToResolve} -> ${targetBotId}`);
                    }
                } catch (e) { console.warn(`[RECOVERY FAILED] Could not resolve bot username @${botUsernameToResolve}`); }
            }

            if (!targetBotId || targetBotId === '0' || Number(targetBotId) < 0) {
                if (Number(source.addonId) > 0) {
                    targetBotId = source.addonId;
                }
            }

            if (targetBotId && Number(targetBotId) > 0) {
                autoDownloadUniqueId = source.uniqueId;

                // --- VIRTUAL REQUEST REGISTRATION (PHASE 9B) ---
                // Register a virtual request so the correlation engine accepts the incoming file message
                if (!activeRequests.has(String(targetBotId))) activeRequests.set(String(targetBotId), []);
                activeRequests.get(String(targetBotId)).push({
                    messageId: 0, // Virtual ID for manual clicks
                    timestamp: Date.now(),
                    title: source.movieTitle || currentDetailItem?.title,
                    year: source.movieYear || currentDetailItem?.year,
                    season: currentDetailItem?.season,
                    episode: currentDetailItem?.episode,
                    sessionId: currentSearchSessionId,
                    isVirtual: true
                });

                pendingFileRequests.set(String(targetBotId), {
                    startParam: effectiveStartParam,
                    botUsername: source.redirectBot || source.botUsername,
                    timestamp: Date.now(),
                    sourceId: source.uniqueId
                });

                console.log(`[ASKING BOT] Sending /start ${effectiveStartParam} to ${targetBotId}`);
                await window.tdClient.send({
                    '@type': 'sendBotStartMessage',
                    'bot_user_id': Number(targetBotId),
                    'chat_id': Number(targetBotId),
                    'parameter': effectiveStartParam
                }).catch(async (e) => {
                    console.log(`[ASKING BOT FALLBACK] sendBotStartMessage failed, sending text /start`, e);
                    await window.tdClient.send({
                        '@type': 'sendMessage',
                        'chat_id': Number(targetBotId),
                        'input_message_content': {
                            '@type': 'inputMessageText',
                            'text': { '@type': 'formattedText', 'text': `/start ${effectiveStartParam}` }
                        }
                    });
                });

                // CRITICAL: If this is a cached source in a PRIVATE chat, we MUST NOT click the button.
                // In a GROUP chat, if we don't have a targetBotId, we MUST click the button
                // to find out which bot to redirect to (the /start command needs a bot ID).
                const isGroup = Number(source.addonId) < 0;
                if (source.fromCache && !isGroup) {
                    console.log(`[CACHE SAFE EXIT] Sent /start for cached item in private chat. Avoiding stale button click.`);
                    return;
                }

                // If it's a group and we successfully sent /start to a recovered targetBotId, we can also skip.
                if (source.fromCache && isGroup && targetBotId && targetBotId !== '0') {
                    console.log(`[CACHE GROUP EXIT] Sent /start to recovered Bot ID ${targetBotId}. Skipping button click.`);
                    return;
                }
            } else {
                console.log(`[REGEN BYPASS] No Bot ID yet for Group ${source.addonId}. Falling back to button click.`);
            }

            if (!source.callbackData) return;
        }

        if (source.callbackData) {
            if (isPlayback) {
                console.log(`[PLAYBACK KEYBOARD CLICK] ${source.addonId} ${source.itemId}`);
                console.log(`[PLAYBACK PATH CALLBACK EXECUTED]`);
            } else {
                console.log(`[DOWNLOAD PATH CALLBACK EXECUTED]`);
            }
            crawlCallback(source.addonId, source.itemId, source.callbackData, source.fileName, true);
            return;
        }
    }

    // Fallback regeneration
    regenerateSource(source);
}

async function regenerateSource(source) {
    if (!source.botUsername || !source.startParam) {
        console.log(`[DOWNLOAD FAILED] No regeneration parameters available for ${source.fileName}`);
        return;
    }
    console.log(`[REQUESTING FRESH FILE] via regeneration for ${source.fileName}`);
    autoDownloadUniqueId = source.uniqueId;
    try {
        const chat = await window.tdClient.send({ '@type': 'searchPublicChat', 'username': source.botUsername });
        console.log(`[BOT RESOLVED] @${source.botUsername} -> ${chat.id}`);

        pendingFileRequests.set(String(chat.id), {
            startParam: source.startParam,
            botUsername: source.botUsername,
            timestamp: Date.now(),
            sourceId: source.uniqueId
        });

        await window.tdClient.send({ '@type': 'sendBotStartMessage', 'bot_user_id': chat.id, 'chat_id': chat.id, 'parameter': source.startParam })
        .catch(async () => {
             await window.tdClient.send({ '@type': 'sendMessage', 'chat_id': chat.id, 'input_message_content': { '@type': 'inputMessageText', 'text': { '@type': 'formattedText', 'text': `/start ${source.startParam}` } } });
        });
        console.log(`[SENDBOTSTARTMESSAGE SENT]`);
    } catch (e) {
        console.log(`[DOWNLOAD FAILED] Regeneration failed`, e);
    }
}

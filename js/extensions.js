let enabledExtensions = [];
let addedExtensions = [];
let searchTimeout = null;

// Load from localStorage on startup
function loadExtensionsFromStorage() {
  const stored = localStorage.getItem('sv_extensions');
  if (stored) {
    try {
      addedExtensions = JSON.parse(stored);
      enabledExtensions = addedExtensions.map(ext => ext.title);
    } catch (e) {
      console.error("Failed to parse stored extensions", e);
      addedExtensions = [];
    }
  }
}

function saveExtensionsToStorage() {
  localStorage.setItem('sv_extensions', JSON.stringify(addedExtensions));
  enabledExtensions = addedExtensions.map(ext => ext.title);
}

document.addEventListener('DOMContentLoaded', () => {
  loadExtensionsFromStorage();
});

function openExtensions() {
  document.getElementById('ext-panel').classList.add('open');
  document.getElementById('ext-overlay').classList.add('open');
  document.getElementById('ext-btn').classList.add('active');
  const q = document.getElementById('ext-search-input').value;
  if (q) searchExtensions();
}

function closeExtensions() {
  document.getElementById('ext-panel').classList.remove('open');
  document.getElementById('ext-overlay').classList.remove('open');
  document.getElementById('ext-btn').classList.remove('active');
}

function switchExtTab(tab) {
  document.getElementById('ext-tab-search').classList.toggle('active', tab === 'search');
  document.getElementById('ext-tab-added').classList.toggle('active', tab === 'added');
  document.getElementById('ext-search-tab').style.display = tab === 'search' ? 'block' : 'none';
  document.getElementById('ext-added-tab').style.display = tab === 'added' ? 'flex' : 'none';
  if (tab === 'added') renderAddedExtensions();
}

function normalizeUsername(q) {
  let normalized = q.trim();
  // Support all formats: @username, username, https://t.me/username, t.me/username
  normalized = normalized.replace(/^(https?:\/\/)?(www\.)?t\.me\//i, '');
  normalized = normalized.replace(/^@/, '');
  return normalized;
}

function isPotentialUsername(q) {
  // If it contains no spaces, it's a potential username
  return q.length > 0 && !q.includes(' ');
}

async function getChatTypeLabel(chat) {
  let typeLabel = "Chat";
  if (chat.type['@type'] === 'chatTypePrivate') {
     try {
       const user = await window.tdClient.send({ '@type': 'getUser', 'user_id': chat.type.user_id });
       typeLabel = user.type['@type'] === 'userTypeBot' ? 'Bot' : 'User';
     } catch (e) {
       console.warn("Failed to get user info for type label", e);
     }
  } else if (chat.type['@type'] === 'chatTypeBasicGroup') {
     typeLabel = 'Group';
  } else if (chat.type['@type'] === 'chatTypeSupergroup') {
     typeLabel = chat.type.is_channel ? 'Channel' : 'Group';
  }
  return typeLabel;
}

async function searchExtensions() {
  const query = document.getElementById('ext-search-input').value.trim();
  const container = document.getElementById('ext-results');

  if (!query) {
    container.innerHTML = '';
    return;
  }

  // Debounce search
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(async () => {
    container.innerHTML = '<div class="ext-empty"><span>Searching Telegram...</span></div>';

    if (!window.tdClient) {
      container.innerHTML = '<div class="ext-empty"><span>Telegram client not ready.</span></div>';
      return;
    }

    // 1. Check for Invite Link
    const isInvite = query.startsWith('https://t.me/+') || query.includes('t.me/joinchat/');
    if (isInvite) {
        console.log(`[INVITE LINK DETECTED] ${query}`);
        try {
            const info = await window.tdClient.send({
                '@type': 'checkChatInviteLink',
                'invite_link': query
            });
            console.log(`[CHECK INVITE SUCCESS]`, info);
            container.innerHTML = '';
            renderInviteLinkResult(info, query, container);
            return;
        } catch (e) {
            console.warn("Invite link check failed", e);
            container.innerHTML = '<div class="ext-empty"><span>Invalid or expired invite link.</span></div>';
            return;
        }
    }

    const normalized = normalizeUsername(query);
    const isLink = query.includes('t.me/');
    if (isLink) console.log(`[LINK DETECTED] ${query}`);

    const chats = new Map(); // Combined results, deduplicated by chatId

    try {
      // 2. Exact username lookup (MODE 1)
      if (isPotentialUsername(normalized)) {
        try {
          const chat = await window.tdClient.send({
            '@type': 'searchPublicChat',
            'username': normalized
          });
          if (chat && chat.id) {
            chats.set(String(chat.id), chat);
          }
        } catch (e) {
          // Silent fail, continue with general search
        }
      }

      // 3. General discovery search (MODE 2)
      const result = await window.tdClient.send({
        '@type': 'searchPublicChats',
        'query': query
      });

      const chatIds = result.chat_ids || [];
      for (const id of chatIds) {
        const key = String(id);
        if (!chats.has(key)) {
          try {
            const chat = await window.tdClient.send({ '@type': 'getChat', 'chat_id': id });
            chats.set(key, chat);
          } catch (e) {
            console.warn("Failed to get chat info for search result", id, e);
          }
        }
      }

      container.innerHTML = '';

      if (chats.size === 0) {
        container.innerHTML = '<div class="ext-empty"><span>No results found.</span></div>';
        return;
      }

      // Display combined list with priority on exact match
      for (const chat of chats.values()) {
        const typeLabel = await getChatTypeLabel(chat);
        renderExtensionResult(chat, typeLabel, container);
      }
    } catch (err) {
      console.error("Search error", err);
      container.innerHTML = '<div class="ext-empty"><span>Unable to search Telegram.</span></div>';
    }
  }, 400);
}

function renderInviteLinkResult(info, inviteLink, container) {
  console.log(`[INVITE CHECKED]`, info);
  const chatId = info.chat_id;
  const isAlreadyAdded = chatId !== 0 && addedExtensions.some(a => String(a.chatId) === String(chatId));

  const el = document.createElement('div');
  el.className = 'ext-result-item';

  const title = info.title || "Private Chat";
  const memberCount = info.member_count > 0 ? `${info.member_count} members` : "Private Link";

  const firstLetter = title.charAt(0).toUpperCase();
  const colors = ["#1a3d1e", "#1a2a3e", "#2a1a3e", "#3e1a1a", "#3e3e1a"];
  const bgColor = colors[Math.abs(title.split('').reduce((a,b)=>a+b.charCodeAt(0),0)) % colors.length];

  let btnText = "+ Join & Add";
  let btnClass = "";
  let isDisabled = false;

  if (isAlreadyAdded) {
      console.log(`[EXTENSION ALREADY EXISTS] ${title}`);
      btnText = "✓ Added";
      btnClass = " added";
      isDisabled = true;
  } else if (chatId !== 0) {
      console.log(`[USER ALREADY MEMBER] ${title}`);
      btnText = "+ Add Extension";
  } else {
      console.log(`[JOIN REQUIRED] ${title}`);
  }

  el.innerHTML = `
    <div class="ext-avatar" style="background:${bgColor}">${firstLetter}</div>
    <div class="ext-result-info">
      <div class="ext-result-name">${title}</div>
      <div class="ext-result-desc">Invite Link • ${memberCount}</div>
    </div>
    <button class="ext-add-btn${btnClass}" id="add-invite-btn" ${isDisabled ? 'disabled' : ''}>
      ${btnText}
    </button>
  `;

  const btn = el.querySelector(`#add-invite-btn`);
  btn.onclick = (e) => {
    e.stopPropagation();
    addExtensionByInvite(inviteLink, btn, chatId);
  };

  container.appendChild(el);
}

async function addExtensionByInvite(inviteLink, btn, existingChatId = 0) {
  if (btn.classList.contains('added')) return;
  btn.disabled = true;
  const originalText = btn.textContent;

  try {
    let chat;
    if (existingChatId !== 0) {
        chat = await window.tdClient.send({
            '@type': 'getChat',
            'chat_id': existingChatId
        });
    } else {
        btn.textContent = 'Joining...';
        chat = await window.tdClient.send({
          '@type': 'joinChatByInviteLink',
          'invite_link': inviteLink
        });
        console.log(`[JOIN SUCCESS] Joined ${chat.title}`);
    }

    // Re-check for duplicate now that we have chat.id
    const isDuplicate = addedExtensions.some(a => String(a.chatId) === String(chat.id));
    if (isDuplicate) {
      console.log(`[DUPLICATE EXTENSION SKIPPED] ${chat.title}`);
      btn.textContent = '✓ Added';
      btn.classList.add('added');
      btn.disabled = false;
      return;
    }

    const typeLabel = await getChatTypeLabel(chat);
    const extension = {
      chatId: chat.id,
      title: chat.title,
      username: chat.type.username || "",
      type: typeLabel,
      color: btn.parentElement.querySelector('.ext-avatar').style.background,
      inviteLink: inviteLink
    };

    addedExtensions.push(extension);
    saveExtensionsToStorage();
    console.log(`[EXTENSION ADDED] ${chat.title}`);

    btn.textContent = '✓ Added';
    btn.classList.add('added');
    btn.disabled = false;

    if (typeof loadSources === 'function' && typeof currentDetailItem !== 'undefined' && currentDetailItem) {
        loadSources(currentDetailItem);
    }
  } catch (err) {
    console.error("Add extension by invite failed", err);
    btn.textContent = 'Error';
    btn.disabled = false;
  }
}

function renderExtensionResult(chat, typeLabel, container) {
  const isAdded = addedExtensions.some(a =>
    String(a.chatId) === String(chat.id) ||
    (chat.type.username && a.username === chat.type.username)
  );

  if (isAdded && document.getElementById('ext-tab-search').classList.contains('active')) {
      return;
  }

  const el = document.createElement('div');
  el.className = 'ext-result-item';

  const title = chat.title || "Unknown Chat";
  const username = chat.type.username ? `@${chat.type.username}` : "";

  const firstLetter = title.charAt(0).toUpperCase();
  const colors = ["#1a3d1e", "#1a2a3e", "#2a1a3e", "#3e1a1a", "#3e3e1a"];
  const bgColor = colors[Math.abs(String(chat.id).split('').reduce((a,b)=>a+b.charCodeAt(0),0)) % colors.length];

  el.innerHTML = `
    <div class="ext-avatar" style="background:${bgColor}">${firstLetter}</div>
    <div class="ext-result-info">
      <div class="ext-result-name">${title}</div>
      <div class="ext-result-desc">${typeLabel} ${username}</div>
    </div>
    <button class="ext-add-btn${isAdded ? ' added' : ''}" id="add-btn-${chat.id}">
      ${isAdded ? '✓ Added' : '+ Add'}
    </button>
  `;

  const btn = el.querySelector(`#add-btn-${chat.id}`);
  btn.onclick = (e) => {
    e.stopPropagation();
    addExtension(chat, typeLabel, btn);
  };

  container.appendChild(el);
}

async function addExtension(chat, typeLabel, btn) {
  if (btn.classList.contains('added')) return;

  const isDuplicate = addedExtensions.some(a =>
    String(a.chatId) === String(chat.id) ||
    (chat.type.username && a.username === chat.type.username)
  );

  if (isDuplicate) {
    console.log(`[DUPLICATE EXTENSION SKIPPED] ${chat.title}`);
    btn.textContent = '✓ Added';
    btn.classList.add('added');
    return;
  }

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Joining...';

  try {
    if (chat.type['@type'] !== 'chatTypePrivate') {
        try {
            const res = await window.tdClient.send({
                '@type': 'joinChat',
                'chat_id': chat.id
            });
            if (res && res['@type'] === 'error' && res.code === 400 && res.message === 'INVITE_REQUEST_SENT') {
                btn.textContent = 'Pending';
            }
        } catch (joinErr) {
            console.warn("Join failed or already member", joinErr);
        }
    }

    const extension = {
      chatId: chat.id,
      title: chat.title,
      username: chat.type.username || "",
      type: typeLabel,
      color: btn.parentElement.querySelector('.ext-avatar').style.background
    };

    addedExtensions.push(extension);
    saveExtensionsToStorage();
    console.log(`[EXTENSION ADDED] ${chat.title}`);

    btn.textContent = '✓ Added';
    btn.classList.add('added');
    btn.disabled = false;

    if (document.getElementById('ext-tab-search').classList.contains('active')) {
        setTimeout(() => {
            if (btn.parentElement) btn.parentElement.remove();
            if (document.getElementById('ext-results').children.length === 0) {
                document.getElementById('ext-results').innerHTML = '<div class="ext-empty"><span>No results found.</span></div>';
            }
        }, 500);
    }

    if (typeof loadSources === 'function' && typeof currentDetailItem !== 'undefined' && currentDetailItem) {
        loadSources(currentDetailItem);
    }
  } catch (err) {
    console.error("Add extension failed", err);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function renderAddedExtensions() {
  const list = document.getElementById('ext-added-list');
  if (addedExtensions.length === 0) {
    list.innerHTML = '<div class="ext-empty"><span>Extensions list is empty.</span></div>';
    return;
  }
  list.innerHTML = '';
  addedExtensions.forEach(ext => {
    const el = document.createElement('div');
    el.className = 'ext-added-item';
    const firstLetter = ext.title.charAt(0).toUpperCase();
    el.innerHTML = `
      <div class="ext-avatar" style="background:${ext.color}">${firstLetter}</div>
      <div class="ext-result-info">
        <div class="ext-added-name">${ext.title}</div>
        <div class="ext-added-sub">${ext.type} ${ext.username ? '@'+ext.username : ''}</div>
      </div>
      <button class="ext-remove-btn" onclick="removeExtension('${ext.chatId}')">Remove</button>
    `;
    list.appendChild(el);
  });
}

function removeExtension(chatId) {
  addedExtensions = addedExtensions.filter(e => String(e.chatId) !== String(chatId));
  saveExtensionsToStorage();
  renderAddedExtensions();
  if (currentDetailItem) loadSources(currentDetailItem);
}

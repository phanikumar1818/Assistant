window.whysperAPI = window.whysperAPI || window.electronAPI;

let allSessions = [];

async function loadHistory() {
  const api = window.whysperAPI || window.electronAPI;
  if (!api || !api.sessionList) return;
  const sessions = await api.sessionList();
  allSessions = sessions;
  renderHistory(sessions);
}

function filterHistory(query) {
  const q = query.toLowerCase();
  const filtered = allSessions.filter(s =>
    (s.title && s.title.toLowerCase().includes(q)) ||
    (s.date && s.date.includes(q))
  );
  renderHistory(filtered);
}

function renderHistory(sessions) {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';

  if (sessions.length === 0) {
    list.innerHTML = '<p style="color: #666; text-align: center; margin-top: 40px;">No sessions found.</p>';
    return;
  }

  sessions.forEach(session => {
    const card = document.createElement('div');
    card.style.cssText = `
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 8px;
      padding: 10px 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      transition: all 0.2s;
    `;

    card.addEventListener('mouseover', () => {
      card.style.background = 'rgba(255, 255, 255, 0.07)';
      card.style.borderColor = 'rgba(255, 255, 255, 0.12)';
    });
    card.addEventListener('mouseout', () => {
      card.style.background = 'rgba(255, 255, 255, 0.04)';
      card.style.borderColor = 'rgba(255, 255, 255, 0.06)';
    });

    card.innerHTML = `
      <div style="flex: 1; min-width: 0;">
        <div style="color: rgba(255,255,255,0.95); font-size: 13px; font-weight: 600;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: sans-serif;">
          ${session.title || 'Untitled Meeting'}
        </div>
        <div style="color: rgba(255,255,255,0.4); font-size: 11px; margin-top: 3px; font-family: sans-serif;">
          ${session.date || ''} · ${session.duration || ''}
        </div>
      </div>
      <button onclick="renameSession('${session.id}')" class="session-btn"
        style="padding: 3px 8px; font-size: 10px;">
        Rename
      </button>
      <button onclick="openSessionFile('${session.id}')" class="session-btn"
        style="padding: 3px 8px; font-size: 10px;">
        Open
      </button>
      <button onclick="deleteSession('${session.id}')" class="session-btn"
        style="padding: 3px 8px; font-size: 10px; background: rgba(239, 68, 68, 0.1); border-color: rgba(239, 68, 68, 0.25); color: #f87171;">
        Delete
      </button>
    `;

    list.appendChild(card);
  });
}

async function renameSession(sessionId) {
  const newTitle = prompt('Enter new meeting title:');
  if (!newTitle || !newTitle.trim()) return;
  const api = window.whysperAPI || window.electronAPI;
  if (!api || !api.sessionRename) return;
  await api.sessionRename(sessionId, newTitle.trim());
  await loadHistory();
}

async function downloadSession(sessionId) {
  const api = window.whysperAPI || window.electronAPI;
  if (!api || !api.sessionGetContent) return;
  const content = await api.sessionGetContent(sessionId);
  if (!content) return;

  const session = allSessions.find(s => s.id === sessionId);
  const title = session && session.title ? session.title : 'Untitled Meeting';
  const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, '').trim() || 'Untitled Meeting';

  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${sanitizedTitle}.md`;
  a.click();
  URL.revokeObjectURL(url);
}

async function deleteSession(sessionId) {
  const confirmed = confirm('Delete this session? This cannot be undone.');
  if (!confirmed) return;
  const api = window.whysperAPI || window.electronAPI;
  if (!api || !api.sessionDelete) return;
  await api.sessionDelete(sessionId);
  await loadHistory();
}

async function openSessionFile(sessionId) {
  const api = window.whysperAPI || window.electronAPI;
  if (api && api.sessionOpenFile) {
    await api.sessionOpenFile(sessionId);
  }
}

// Export functions to global scope for inline HTML handlers
window.loadHistory = loadHistory;
window.filterHistory = filterHistory;
window.renameSession = renameSession;
window.downloadSession = downloadSession;
window.deleteSession = deleteSession;
window.openSessionFile = openSessionFile;


(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const input = $('promptInput'), messages = $('messages'), welcome = $('welcome');
  const historyList = $('historyList'), toast = $('toast'), modal = $('modalBackdrop');
  let chats = [], activeChatId = null, attachments = [], toastTimer = null, currentUser = null;
  let authMode = 'login', sending = false;
  const storagePrefix = 'lezo-ai-account-';

  function showToast(message) {
    toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
  }
  function showModal(title, text) {
    $('modalTitle').textContent = title; $('modalText').textContent = text; modal.classList.add('open');
  }
  function closeModal() { modal.classList.remove('open'); }
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `حصل خطأ (${response.status}).`);
    return data;
  }
  function accountStorageKey() { return storagePrefix + (currentUser?.id || 'guest'); }
  function save() {
    if (!currentUser) return;
    try { localStorage.setItem(accountStorageKey(), JSON.stringify({ chats, activeChatId, light: document.body.classList.contains('light') })); }
    catch { showToast('تعذّر حفظ سجل المحادثات في المتصفح.'); }
  }
  function load() {
    try {
      const data = JSON.parse(localStorage.getItem(accountStorageKey()) || '{}');
      chats = Array.isArray(data.chats) ? data.chats : [];
      activeChatId = data.activeChatId || null;
      if (data.light) document.body.classList.add('light');
    } catch { chats = []; activeChatId = null; }
  }
  function currentChat() { return chats.find(c => c.id === activeChatId); }
  function createChat() {
    const chat = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), title: 'محادثة جديدة', messages: [], updated: Date.now() };
    chats.unshift(chat); activeChatId = chat.id; renderChat(); renderHistory(); save(); input.focus();
  }
  function renderChat() {
    const chat = currentChat(); messages.replaceChildren();
    welcome.style.display = chat && chat.messages.length ? 'none' : 'block';
    if (!chat) { messages.style.display = 'none'; return; }
    messages.style.display = chat.messages.length ? 'flex' : 'none';
    chat.messages.forEach(msg => {
      const row = document.createElement('article'); row.className = `message ${msg.role === 'assistant' ? 'assistant' : 'user'}`;
      const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = msg.role === 'assistant' ? '✳' : (currentUser?.name?.[0] || 'أ');
      const body = document.createElement('div'); body.className = 'message-body';
      const name = document.createElement('div'); name.className = 'message-name'; name.textContent = msg.role === 'assistant' ? 'Lezo-AI' : 'أنت';
      const content = document.createElement('div'); content.className = 'message-content'; content.textContent = msg.text || '';
      body.append(name, content);
      if (msg.files?.length) { const files = document.createElement('div'); files.className = 'message-system'; files.textContent = '📎 ' + msg.files.join('، '); body.append(files); }
      row.append(avatar, body); messages.append(row);
    });
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
  }
  function renderHistory() {
    historyList.replaceChildren();
    if (!chats.length) { const empty = document.createElement('div'); empty.className = 'history-empty'; empty.textContent = 'محادثاتك الجديدة هتظهر هنا'; historyList.append(empty); return; }
    chats.slice(0, 20).forEach(chat => {
      const item = document.createElement('div'); item.className = 'history-entry'; item.title = chat.title;
      const icon = document.createElement('span'); icon.textContent = '◌';
      const label = document.createElement('span'); label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;color:inherit'; label.textContent = chat.title;
      item.append(icon, label); item.addEventListener('click', () => { activeChatId = chat.id; renderChat(); renderHistory(); save(); closeSidebar(); }); historyList.append(item);
    });
  }
  function setBusy(busy) {
    sending = busy; $('sendBtn').disabled = busy; $('sendBtn').textContent = busy ? '…' : '↑'; input.disabled = busy;
  }
  async function sendMessage(textOverride) {
    if (sending) return;
    const text = (textOverride !== undefined ? textOverride : input.value).trim();
    if (!text && !attachments.length) { showToast('اكتب رسالة الأول.'); input.focus(); return; }
    if (attachments.length) {
      showToast('إرفاق أسماء الملفات ظاهر في الواجهة، لكن رفع محتوى الملفات غير مفعّل في هذه النسخة. ابعت محتوى الملف كنص.');
      if (!text) return;
    }
    if (!currentChat()) createChat();
    const chat = currentChat();
    chat.messages.push({ role: 'user', text });
    if (chat.title === 'محادثة جديدة') chat.title = text.length > 30 ? text.slice(0, 30) + '…' : text || 'محادثة جديدة';
    chat.updated = Date.now(); input.value = ''; input.style.height = 'auto'; attachments = []; renderAttachments(); updateCount(); renderChat(); renderHistory(); save(); setBusy(true);
    const typing = document.createElement('article'); typing.className = 'message assistant';
    const av = document.createElement('div'); av.className = 'message-avatar'; av.textContent = '✳';
    const bd = document.createElement('div'); bd.className = 'message-body';
    const nm = document.createElement('div'); nm.className = 'message-name'; nm.textContent = 'Lezo-AI';
    const tx = document.createElement('div'); tx.className = 'message-content typing-indicator'; tx.textContent = '•••'; bd.append(nm, tx); typing.append(av, bd); messages.append(typing); messages.style.display = 'flex'; welcome.style.display = 'none'; $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
    try {
      const payload = chat.messages.slice(-20).map(m => ({ role: m.role, content: m.text }));
      const result = await api('/api/chat', { method: 'POST', body: JSON.stringify({ messages: payload }) });
      chat.messages.push({ role: 'assistant', text: result.answer });
      chat.updated = Date.now();
    } catch (err) {
      chat.messages.push({ role: 'assistant', text: `حصلت مشكلة: ${err.message}` });
    } finally {
      setBusy(false); renderChat(); renderHistory(); save(); input.focus();
    }
  }
  function renderAttachments() {
    const list = $('attachmentList'); list.replaceChildren();
    attachments.forEach((file, i) => {
      const chip = document.createElement('span'); chip.className = 'attachment-chip';
      const name = document.createElement('span'); name.textContent = file.name;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.title = 'إزالة الملف';
      remove.addEventListener('click', () => { attachments.splice(i, 1); renderAttachments(); }); chip.append(name, remove); list.append(chip);
    });
  }
  function updateCount() {
    if (input.value.length > 4000) input.value = input.value.slice(0, 4000);
    $('charCount').textContent = `${input.value.length} / 4000`;
  }
  function closeSidebar() { $('sidebar').classList.remove('open'); $('scrim').classList.remove('open'); }
  function toggleSidebar() { $('sidebar').classList.toggle('open'); $('scrim').classList.toggle('open'); }
  function showAuth() { $('authScreen').classList.remove('hidden'); $('appShell').classList.add('auth-locked'); }
  function showApp(user) {
    currentUser = user; $('authScreen').classList.add('hidden'); $('appShell').classList.remove('auth-locked');
    $('profileName').textContent = user.name || 'حسابي'; $('profileEmail').textContent = user.email || '';
    $('profileAvatar').textContent = (user.name || 'L').trim()[0].toUpperCase(); $('logoutButton').textContent = (user.name || 'L').trim()[0].toUpperCase();
    load(); if (!activeChatId || !chats.some(c => c.id === activeChatId)) activeChatId = null;
    renderChat(); renderHistory(); updateCount();
  }
  function setAuthMode(mode) {
    authMode = mode; const registering = mode === 'register';
    $('loginTab').classList.toggle('active', !registering); $('registerTab').classList.toggle('active', registering);
    $('nameField').classList.toggle('hidden', !registering); $('authName').classList.toggle('hidden', !registering);
    $('authName').required = registering; $('authName').autocomplete = 'name';
    $('authPassword').autocomplete = registering ? 'new-password' : 'current-password';
    $('authTitle').innerHTML = registering ? 'أنشئ حسابك في <span>Lezo-AI</span>' : 'أهلًا بعودتك إلى <span>Lezo-AI</span>';
    $('authSubtitle').textContent = registering ? 'اعمل حسابك وابدأ استخدام مساعدك الذكي.' : 'سجّل دخولك وابدأ محادثة جديدة مع مساعدك الذكي.';
    $('authSubmit').innerHTML = registering ? 'إنشاء حساب <span>←</span>' : 'تسجيل الدخول <span>←</span>';
    $('authError').textContent = ''; $('authError').classList.remove('show');
  }
  $('loginTab').addEventListener('click', () => setAuthMode('login'));
  $('registerTab').addEventListener('click', () => setAuthMode('register'));
  $('authForm').addEventListener('submit', async e => {
    e.preventDefault(); const error = $('authError'), submit = $('authSubmit');
    error.classList.remove('show'); submit.disabled = true; submit.textContent = 'لحظة واحدة…';
    const payload = { email: $('authEmail').value.trim(), password: $('authPassword').value };
    if (authMode === 'register') payload.name = $('authName').value.trim();
    try {
      const result = await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify(payload) });
      $('authPassword').value = ''; showApp(result.user); showToast(authMode === 'register' ? 'حسابك اتعمل بنجاح، أهلًا بيك!' : 'تم تسجيل الدخول بنجاح.');
    } catch (err) { error.textContent = err.message; error.classList.add('show'); }
    finally { submit.disabled = false; setAuthMode(authMode); }
  });

  $('newChat').addEventListener('click', createChat);
  $('sendBtn').addEventListener('click', () => sendMessage());
  input.addEventListener('input', () => { updateCount(); input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 150) + 'px'; });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });
  document.querySelectorAll('[data-prompt]').forEach(btn => btn.addEventListener('click', () => { input.value = btn.dataset.prompt; updateCount(); input.focus(); input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; }));
  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', e => {
    const incoming = Array.from(e.target.files || []), room = Math.max(0, 5 - attachments.length);
    attachments.push(...incoming.slice(0, room)); if (incoming.length > room) showToast('تقدر تختار حتى 5 ملفات.'); renderAttachments(); e.target.value = '';
    if (attachments.length) showToast('الملفات ظاهرة كمرفقات فقط؛ إرسال محتواها غير مفعّل حاليًا.');
  });
  $('clearHistory').addEventListener('click', () => {
    if (!chats.length) { showToast('لا توجد محادثات لمسحها.'); return; }
    showModal('مسح المحادثات', 'هل تريد حذف كل المحادثات المحفوظة محليًا في هذا المتصفح؟');
    $('modalOk').textContent = 'حذف المحادثات'; $('modalOk').onclick = () => { chats = []; activeChatId = null; save(); renderChat(); renderHistory(); closeModal(); $('modalOk').textContent = 'تمام'; $('modalOk').onclick = closeModal; showToast('تم مسح سجل المحادثات المحلي.'); };
  });
  $('appearanceBtn').addEventListener('click', () => { document.body.classList.toggle('light'); save(); showToast(document.body.classList.contains('light') ? 'تم تفعيل المظهر الفاتح.' : 'تم تفعيل المظهر الداكن.'); });
  $('shareBtn').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); showToast('تم نسخ رابط الصفحة.'); } catch { showModal('مشاركة Lezo-AI', 'انسخ رابط الموقع من شريط العنوان لمشاركته.'); } });
  $('modeBtn').addEventListener('click', () => showModal('وضع الكتابة', 'اكتب في الرسالة أنك تريد وضع البرمجة أو الكتابة أو تحليل الكود، وسيحاول Lezo-AI مساعدتك.'));
  $('profileButton').addEventListener('click', () => showModal('الحساب الشخصي', `${currentUser?.name || ''}\n${currentUser?.email || ''}\nاستخدم زر الحساب أعلى الصفحة لتسجيل الخروج.`));
  $('logoutButton').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch {}
    currentUser = null; chats = []; activeChatId = null; showAuth(); setAuthMode('login'); showToast('تم تسجيل الخروج.');
  });
  $('keyboardHelp').addEventListener('click', () => showModal('اختصارات لوحة المفاتيح', 'Enter: إرسال الرسالة\nShift + Enter: سطر جديد\nCtrl + K: محادثة جديدة'));
  $('closeModal').addEventListener('click', closeModal); $('modalOk').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  $('openSidebar').addEventListener('click', toggleSidebar); $('closeSidebar').addEventListener('click', closeSidebar); $('scrim').addEventListener('click', closeSidebar);
  document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active')); btn.classList.add('active');
    if (btn.dataset.view !== 'chat') showModal(btn.textContent.trim(), 'القسم ظاهر في التصميم، وسيتم تفعيله في مرحلة تطوير لاحقة.');
    else { welcome.style.display = currentChat() && currentChat().messages.length ? 'none' : 'block'; }
    closeSidebar();
  }));
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && currentUser) { e.preventDefault(); createChat(); } if (e.key === 'Escape') { closeModal(); closeSidebar(); } });

  (async () => {
    showAuth(); setAuthMode('login');
    try { const result = await api('/api/auth/me'); showApp(result.user); }
    catch { /* Login screen remains visible when not authenticated. */ }
  })();
})();

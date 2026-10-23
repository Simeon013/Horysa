(() => {
  'use strict';

  const cfg = window.HORYSA_SUPABASE || {};
  const configured = Boolean(cfg.url && cfg.publishableKey);
  const sessionKey = 'horysa:cloud-session:v1';
  const userKey = 'horysa:cloud-user:v1';
  const ownerKey = 'horysa:cloud-owner:v1';
  const guestSnapshotKey = 'horysa:guest-snapshot:v1';
  const catalogCacheKey = 'horysa:catalog-cache:v1';
  const keys = { favorites: 'horysa:favorites:v1', agenda: 'horysa:agenda:v1', routes: 'horysa:routes:v1' };
  const state = { session: null, user: null, admin: false, entries: [], ready: false, syncTimer: 0 };
  const $ = (selector) => document.querySelector(selector);
  const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
  const snapshot = () => Object.fromEntries(Object.entries(keys).map(([name, key]) => [name, read(key, [])]));
  const emptySnapshot = () => ({ favorites: [], agenda: [], routes: [] });
  const accountSnapshotKey = () => `horysa:account-snapshot:${state.user?.id || 'guest'}:v1`;
  const saveSnapshot = (data) => Object.entries(keys).forEach(([name, key]) => localStorage.setItem(key, JSON.stringify(Array.isArray(data?.[name]) ? data[name] : [])));
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (value) => { try { const url = new URL(value); return url.protocol === 'https:' ? url.href : ''; } catch { return ''; } };
  const announce = (message) => { const toast = $('#toast'); if (toast) { toast.textContent = message; toast.classList.add('visible'); setTimeout(() => toast.classList.remove('visible'), 2400); } };
  const endpoint = (path) => `${String(cfg.url).replace(/\/$/, '')}${path}`;
  const emptyActions = () => ({ favorites: {}, agenda: {}, routes: {} });
  const actionKey = () => `horysa:cloud-actions:${state.user?.id || 'guest'}:v1`;
  const getActions = () => { const value = read(actionKey(), emptyActions()); return { favorites: value.favorites || {}, agenda: value.agenda || {}, routes: value.routes || {} }; };
  const saveActions = (value) => localStorage.setItem(actionKey(), JSON.stringify(value));

  function setSession(session) {
    state.session = session || null;
    if (session?.access_token) localStorage.setItem(sessionKey, JSON.stringify(session));
    else localStorage.removeItem(sessionKey);
    refreshAccountUi();
  }

  async function refreshToken() {
    const current = state.session;
    if (!current?.refresh_token) throw new Error('Session expirée. Demandez un nouveau lien de connexion.');
    const response = await fetch(endpoint('/auth/v1/token?grant_type=refresh_token'), {
      method: 'POST', headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refresh_token })
    });
    const body = await response.json();
    if (!response.ok) { setSession(null); throw new Error(body.msg || body.message || 'Session expirée.'); }
    setSession(body);
    return body.access_token;
  }

  async function api(path, options = {}, retried = false) {
    if (!configured) throw new Error('La synchronisation attend la configuration du projet Horysa.');
    const token = state.session?.access_token || cfg.publishableKey;
    const headers = { apikey: cfg.publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) };
    let response = await fetch(endpoint(path), { ...options, headers });
    if (response.status === 401 && state.session?.refresh_token && !retried) {
      await refreshToken();
      return api(path, options, true);
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    if (!response.ok) throw new Error(body?.message || body?.msg || body?.hint || `Erreur du service (${response.status}).`);
    return body;
  }

  function mergeLists(local, remote) {
    const merged = new Map();
    for (const item of [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])]) {
      const id = typeof item === 'string' ? item : item?.id;
      if (id) merged.set(id, item);
    }
    return [...merged.values()];
  }

  async function syncInitial() {
    if (!state.user) return;
    const rows = await api(`/rest/v1/user_data?select=data,updated_at&user_id=eq.${encodeURIComponent(state.user.id)}&limit=1`);
    const previousOwner = localStorage.getItem(ownerKey);
    if (!previousOwner) localStorage.setItem(guestSnapshotKey, JSON.stringify(snapshot()));
    const local = !previousOwner || previousOwner === state.user.id
      ? snapshot()
      : read(accountSnapshotKey(), emptySnapshot());
    if (previousOwner && previousOwner !== state.user.id) saveSnapshot(local);
    const remote = rows?.[0]?.data || {};
    const remoteActions = remote.actions || emptyActions();
    for (const name of Object.keys(keys)) { remoteActions[name] ||= {}; }
    for (const name of Object.keys(keys)) for (const id of remote.deleted?.[name] || []) {
      remoteActions[name][id] ||= { at: rows?.[0]?.updated_at || '1970-01-01T00:00:00.000Z', deleted: true };
    }
    const localActions = getActions();
    const actions = Object.fromEntries(Object.keys(keys).map(name => {
      const merged = { ...remoteActions[name] };
      for (const [id, action] of Object.entries(localActions[name])) {
        if (!merged[id] || Date.parse(action.at) > Date.parse(merged[id].at)) merged[id] = action;
      }
      return [name, merged];
    }));
    const merged = Object.fromEntries(Object.keys(keys).map(name => {
      const values = name === 'favorites' ? [...new Set([...(remote[name] || []), ...local[name]])] : mergeLists(local[name], remote[name]);
      return [name, values.filter(item => !actions[name][typeof item === 'string' ? item : item?.id]?.deleted)];
    }));
    saveActions(actions);
    saveSnapshot(merged);
    localStorage.setItem(ownerKey, state.user.id);
    localStorage.setItem(accountSnapshotKey(), JSON.stringify(merged));
    await pushSnapshot();
    await loadCatalog();
    state.admin = Boolean(await api('/rest/v1/rpc/is_horysa_admin', { method: 'POST', body: '{}' }));
    state.ready = true;
    refreshAccountUi();
    document.dispatchEvent(new CustomEvent('horysa:cloud-ready'));
  }

  async function pushSnapshot() {
    if (!state.session || !state.user || !configured || !navigator.onLine) return;
    try {
      await api('/rest/v1/user_data?on_conflict=user_id', {
        method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: state.user.id, data: { ...snapshot(), actions: getActions() } })
      });
      localStorage.setItem(accountSnapshotKey(), JSON.stringify(snapshot()));
      state.ready = true;
      refreshAccountUi();
    } catch (error) {
      refreshAccountUi(error.message);
    }
  }

  function persist() {
    if (!state.session) return;
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(pushSnapshot, 500);
  }

  function trackItem(collection, id, deleted) {
    if (!state.user || !keys[collection] || !id) return;
    const value = getActions();
    value[collection][id] = { at: new Date().toISOString(), deleted: Boolean(deleted) };
    saveActions(value);
  }

  function restoreGuestSnapshot() {
    saveSnapshot(read(guestSnapshotKey, emptySnapshot()));
    localStorage.removeItem(ownerKey);
  }

  async function loadCatalog() {
    try {
      const rows = await api('/rest/v1/catalog_entries?select=id,kind,city,title,description,category,area,latitude,longitude,source_url,starts_at,ends_at,created_at&status=eq.published&order=created_at.desc&limit=200');
      state.entries = Array.isArray(rows) ? rows : [];
      localStorage.setItem(catalogCacheKey, JSON.stringify(state.entries));
    } catch (error) {
      state.entries = read(catalogCacheKey, []);
      if (!Array.isArray(state.entries)) state.entries = [];
      refreshAccountUi(error.message);
    }
    window.HorysaSetCatalogEntries?.(state.entries);
  }

  async function startLogin(event) {
    event.preventDefault();
    const error = $('#account-error');
    if (!configured) { error.textContent = 'Le projet Supabase Horysa ne peut pas encore être créé : le compte est à sa limite gratuite. La connexion sera activée dès qu’un emplacement gratuit sera disponible.'; return; }
    const email = String(new FormData(event.currentTarget).get('email') || '').trim();
    try {
      error.textContent = '';
      const url = new URL(endpoint('/auth/v1/otp'));
      url.searchParams.set('redirect_to', `${location.origin}${location.pathname}`);
      const response = await fetch(url, { method: 'POST', headers: { apikey: cfg.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, create_user: true }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.msg || body.message || 'Impossible d’envoyer le lien.');
      $('#account-message').textContent = `Un lien de connexion vient d’être envoyé à ${email}. Ouvrez-le sur cet appareil pour synchroniser votre carnet.`;
      event.currentTarget.reset();
    } catch (e) { error.textContent = e.message; }
  }

  async function acceptMagicLink() {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get('access_token')) {
      const session = { access_token: hash.get('access_token'), refresh_token: hash.get('refresh_token'), expires_at: Number(hash.get('expires_at') || 0) };
      setSession(session);
      history.replaceState(null, '', `${location.pathname}${location.search}#explorer`);
      try {
        const users = await api('/auth/v1/user');
        state.user = users;
        localStorage.setItem(userKey, JSON.stringify({ id: state.user.id, email: state.user.email }));
        await syncInitial();
        announce('Votre carnet est synchronisé.');
      } catch (e) { announce(e.message); }
    }
  }

  async function restoreSession() {
    try { state.session = JSON.parse(localStorage.getItem(sessionKey) || 'null'); } catch { state.session = null; }
    if (!state.session) return;
    try { state.user = JSON.parse(localStorage.getItem(userKey) || 'null'); } catch { state.user = null; }
    if (!navigator.onLine) { refreshAccountUi(); return; }
    try {
      if (state.session.expires_at && state.session.expires_at * 1000 < Date.now() + 30000) await refreshToken();
      state.user = await api('/auth/v1/user');
      localStorage.setItem(userKey, JSON.stringify({ id: state.user.id, email: state.user.email }));
      await syncInitial();
    } catch (error) { if (!state.user) throw error; refreshAccountUi(error.message); }
  }

  function refreshAccountUi(error = '') {
    const button = $('#account-open');
    if (button) button.textContent = state.user ? 'Mon compte' : 'Compte';
    const title = $('#account-title');
    const message = $('#account-message');
    if (title && state.user) title.textContent = 'Carnet synchronisé';
    if (message && state.user) message.textContent = state.user.email || 'Votre compte Horysa est connecté.';
    const sync = $('#account-sync-state');
    if (sync) sync.textContent = error || (state.user ? (navigator.onLine ? 'Vos favoris, balades et sorties sont synchronisés.' : 'Hors connexion · vos changements seront synchronisés au retour du réseau.') : 'Sans compte, votre carnet reste enregistré sur cet appareil.');
    const signOut = $('#sign-out'); const remove = $('#delete-account');
    if (signOut) signOut.hidden = !state.user;
    if (remove) remove.hidden = !state.user;
    const adminNav = document.querySelector('[data-view="moderation"]');
    if (adminNav) adminNav.hidden = !state.admin;
  }

  function renderEvents() {
    const events = state.entries.filter(item => item.kind === 'event');
    const now = new Date();
    const current = events.filter(item => item.ends_at ? new Date(item.ends_at) >= now : (!item.starts_at || new Date(item.starts_at) >= now));
    const list = current.length ? `<div class="event-catalog">${current.map(item => { const source = safeUrl(item.source_url); return `<article class="event-catalog-card"><p class="kicker">${esc(item.city)} · ÉVÉNEMENT VÉRIFIÉ</p><h3>${esc(item.title)}</h3><p>${esc(item.description)}</p><div class="event-catalog-meta">${item.starts_at ? `<span>◷ ${esc(new Date(item.starts_at).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }))}</span>` : '<span>Date à confirmer</span>'}${item.area ? `<span>⌖ ${esc(item.area)}</span>` : ''}</div>${source ? `<a class="text-link" href="${esc(source)}" target="_blank" rel="noopener noreferrer">Consulter la source ↗</a>` : ''}</article>`; }).join('')}</div>` : '<div class="empty-state"><div class="empty-icon">✳</div><h3>Pas encore d’événements publiés</h3><p>Horysa n’affiche que des événements dont la source et la date ont été vérifiées. Vous pouvez nous en proposer un.</p><button class="primary-button" data-view="proposer">Proposer un événement <span>↗</span></button></div>';
    return `<section class="view"><div class="view-head"><div><p class="kicker"><span class="rule"></span> SORTIR EN VILLE</p><h1 class="view-title">Événements <em>à Cotonou.</em></h1><p class="view-deck">Une sélection éditoriale, datée et vérifiée avant publication.</p></div><button class="secondary-button" data-view="proposer">Proposer une sortie <span>＋</span></button></div>${configured ? '<p class="freshness-note">Informations vérifiées avant publication · consultez la source avant de vous déplacer.</p>' : '<div class="inline-notice"><b>i</b><span>Le catalogue en ligne apparaîtra lorsque le projet de données Horysa aura été créé. Aucun faux flux temps réel n’est affiché.</span></div>'}${list}</section>`;
  }

  function renderSuggestions() {
    const signedIn = Boolean(state.user);
    return `<section class="view"><div class="view-head"><div><p class="kicker"><span class="rule"></span> LE BÉNIN SE RACONTE ENSEMBLE</p><h1 class="view-title">Une adresse à <em>partager.</em></h1><p class="view-deck">Aidez à faire grandir Horysa. Chaque proposition est vérifiée et sourcée avant publication.</p></div></div><div class="suggestion-intro"><span class="home-bottom-icon">✳</span><div><h2>Des bonnes adresses, des événements et des histoires locales.</h2><p>${configured ? (signedIn ? 'Connecté : votre proposition sera envoyée à la file de vérification.' : 'Connectez-vous par lien e-mail pour envoyer une proposition.') : 'Les contributions seront activées avec le service de données Horysa. La fiche ne sera jamais publiée sans vérification.'}</p>${configured && signedIn ? '<button class="primary-button" data-open-suggestion>Faire une proposition <span>↗</span></button>' : '<button class="primary-button" data-account-open>Se connecter <span>↗</span></button>'}</div></div><div class="moderation-principles"><h3>Comment fonctionne la vérification ?</h3><ul><li>La source et la date sont contrôlées avant publication.</li><li>Les informations personnelles ne sont pas affichées.</li><li>Un événement périmé est retiré du catalogue.</li></ul></div></section>`;
  }

  async function submitSuggestion(event) {
    event.preventDefault();
    const error = $('#suggestion-error');
    if (!configured || !state.user) { error.textContent = 'Connectez-vous et réessayez quand le service Horysa sera disponible.'; return; }
    const form = event.currentTarget; const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    for (const field of ['starts_at','ends_at']) if (payload[field]) payload[field] = new Date(payload[field]).toISOString();
    if (!payload.source_url) delete payload.source_url;
    try {
      await api('/rest/v1/submissions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: state.user.id, kind: payload.kind, payload }) });
      form.reset(); $('#suggestion-dialog').close(); announce('Merci ! Votre proposition attend sa vérification.');
    } catch (e) { error.textContent = e.message; }
  }

  async function renderModeration() {
    if (!state.user || !state.admin) return '<section class="view"><div class="empty-state"><h2>Accès réservé</h2><p>Cette rubrique est réservée aux comptes modérateurs.</p></div></section>';
    try {
      const rows = await api('/rest/v1/submissions?select=id,kind,payload,created_at,user_id&status=eq.pending&order=created_at.asc');
      if (!rows.length) return '<section class="view"><div class="view-head"><div><p class="kicker">ESPACE ÉDITORIAL</p><h1 class="view-title">File de <em>vérification.</em></h1></div></div><div class="empty-state"><h3>Tout est à jour</h3><p>Aucune proposition en attente.</p></div></section>';
      return `<section class="view"><div class="view-head"><div><p class="kicker">ESPACE ÉDITORIAL</p><h1 class="view-title">File de <em>vérification.</em></h1><p class="view-deck">${rows.length} proposition${rows.length > 1 ? 's' : ''} à examiner.</p></div></div><div class="submission-list">${rows.map(row => { const source = safeUrl(row.payload.source_url); return `<article class="submission-card"><p class="kicker">${esc(row.kind)} · ${esc(row.payload.city || 'Bénin')} · ${esc(new Date(row.created_at).toLocaleDateString('fr-FR'))}</p><h3>${esc(row.payload.title)}</h3><p>${esc(row.payload.description)}</p>${source ? `<a href="${esc(source)}" target="_blank" rel="noopener noreferrer">Ouvrir la source ↗</a>` : '<p class="freshness-note">Aucune source transmise · vérifier avant validation.</p>'}<div class="submission-actions"><button class="primary-button" data-review="approve" data-submission="${esc(row.id)}">Valider et publier</button><button class="secondary-button" data-review="reject" data-submission="${esc(row.id)}">Refuser</button></div></article>`; }).join('')}</div></section>`;
    } catch (e) { return `<section class="view"><div class="empty-state"><h2>La file n’a pas pu être chargée</h2><p>${esc(e.message)}</p></div></section>`; }
  }

  async function review(id, approve) {
    try {
      await api('/rest/v1/rpc/review_horysa_submission', { method: 'POST', body: JSON.stringify({ submission_id: id, approve, note: null }) });
      announce(approve ? 'Proposition vérifiée et publiée.' : 'Proposition refusée.');
      document.dispatchEvent(new CustomEvent('horysa:render-view'));
    } catch (e) { announce(e.message); }
  }

  function exportData() {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), account: state.user?.email || null, ...snapshot() }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'horysa-mes-donnees.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }

  async function deleteAccount() {
    if (!state.user || !confirm('Supprimer définitivement votre compte Horysa et les données synchronisées ? Cette action ne peut pas être annulée.')) return;
    try {
      await api('/rest/v1/rpc/delete_my_horysa_account', { method: 'POST', body: '{}' });
      localStorage.removeItem(actionKey()); localStorage.removeItem(accountSnapshotKey()); restoreGuestSnapshot();
      setSession(null); state.user = null; state.admin = false; localStorage.removeItem(userKey);
      $('#account-dialog').close(); announce('Votre compte et ses données ont été supprimés.');
    } catch (e) { $('#account-sync-state').textContent = e.message; }
  }

  document.addEventListener('click', async (event) => {
    if (event.target.closest('#account-open, [data-account-open]')) { $('#account-dialog').showModal(); refreshAccountUi(); }
    if (event.target.closest('#export-data')) exportData();
    if (event.target.closest('#sign-out')) { localStorage.setItem(accountSnapshotKey(), JSON.stringify(snapshot())); pushSnapshot(); restoreGuestSnapshot(); setSession(null); state.user = null; state.admin = false; localStorage.removeItem(userKey); $('#account-dialog').close(); announce('Vous êtes déconnecté.'); }
    if (event.target.closest('#delete-account')) deleteAccount();
    if (event.target.closest('[data-open-suggestion]')) $('#suggestion-dialog').showModal();
    const reviewButton = event.target.closest('[data-review]');
    if (reviewButton) review(reviewButton.dataset.submission, reviewButton.dataset.review === 'approve');
  });
  $('#account-form')?.addEventListener('submit', startLogin);
  $('#suggestion-form')?.addEventListener('submit', submitSuggestion);
  window.addEventListener('online', () => { pushSnapshot(); loadCatalog(); });
  window.addEventListener('storage', (event) => { if (Object.values(keys).includes(event.key)) persist(); });

  window.HorysaCloud = {
    configured,
    persist,
    trackItem,
    get admin() { return state.admin; },
    async init() {
      if (configured) {
        await acceptMagicLink();
        if (!state.user) { try { await restoreSession(); } catch (e) { setSession(null); refreshAccountUi(e.message); } }
        try { await loadCatalog(); } catch (e) { refreshAccountUi(e.message); }
      }
      refreshAccountUi();
    },
    async renderView(view) {
      const root = $('#view-root');
      if (view === 'evenements') {
        if (configured) { try { await loadCatalog(); } catch {} }
        root.innerHTML = renderEvents();
      } else if (view === 'proposer') root.innerHTML = renderSuggestions();
      else if (view === 'moderation') root.innerHTML = await renderModeration();
    }
  };
})();

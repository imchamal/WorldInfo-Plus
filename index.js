import { eventSource, event_types } from '../../../../script.js';
import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';

const MODULE_NAME = 'worldInfoPlus';
const UNFILED_ID = '__unfiled';

let root;
let currentBookName = '';
let currentData = null;
let isSaving = false;

function createElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function getSelectedBookName() {
    const select = document.querySelector('#world_editor_select');
    if (!select || !select.value) return '';
    const selected = select?.selectedOptions?.[0];
    const name = selected?.textContent?.trim();
    return name || '';
}

function ensureStore(data) {
    data.metadata ??= {};
    data.metadata[MODULE_NAME] ??= {};

    const store = data.metadata[MODULE_NAME];
    store.folders = Array.isArray(store.folders) ? store.folders : [];
    store.folderOrder = Array.isArray(store.folderOrder) ? store.folderOrder : [];
    store.entryFolders = store.entryFolders && typeof store.entryFolders === 'object' ? store.entryFolders : {};
    store.entryOrder = store.entryOrder && typeof store.entryOrder === 'object' ? store.entryOrder : {};

    const knownFolderIds = new Set(store.folders.map(folder => folder.id));
    store.folderOrder = store.folderOrder.filter(id => knownFolderIds.has(id));

    for (const folder of store.folders) {
        if (!store.folderOrder.includes(folder.id)) {
            store.folderOrder.push(folder.id);
        }
        store.entryOrder[folder.id] = Array.isArray(store.entryOrder[folder.id]) ? store.entryOrder[folder.id] : [];
    }

    store.entryOrder[UNFILED_ID] = Array.isArray(store.entryOrder[UNFILED_ID]) ? store.entryOrder[UNFILED_ID] : [];

    return store;
}

function getOrderedFolders(store) {
    const byId = new Map(store.folders.map(folder => [folder.id, folder]));
    return store.folderOrder
        .map(id => byId.get(id))
        .filter(Boolean);
}

function sortEntriesForFolder(entries, order) {
    const index = new Map(order.map((uid, position) => [String(uid), position]));
    return [...entries].sort((a, b) => {
        const aIndex = index.has(String(a.uid)) ? index.get(String(a.uid)) : Number.MAX_SAFE_INTEGER;
        const bIndex = index.has(String(b.uid)) ? index.get(String(b.uid)) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return Number(a.uid) - Number(b.uid);
    });
}

function groupEntries(data, store) {
    const folderIds = new Set(store.folders.map(folder => folder.id));
    const grouped = { [UNFILED_ID]: [] };

    for (const folder of store.folders) {
        grouped[folder.id] = [];
    }

    for (const entry of Object.values(data.entries ?? {})) {
        const uid = String(entry.uid);
        const folderId = store.entryFolders[uid];
        if (folderId && folderIds.has(folderId)) {
            grouped[folderId].push(entry);
        } else {
            grouped[UNFILED_ID].push(entry);
        }
    }

    for (const [folderId, entries] of Object.entries(grouped)) {
        grouped[folderId] = sortEntriesForFolder(entries, store.entryOrder[folderId] ?? []);
    }

    return grouped;
}

function setStatus(message) {
    root.querySelector('.wip-status').textContent = message;
}

async function saveCurrentData() {
    if (!currentBookName || !currentData || isSaving) return;
    isSaving = true;
    setStatus('Saving...');

    try {
        await saveWorldInfo(currentBookName, currentData, true);
        setStatus('Saved');
    } catch (error) {
        console.error('[WorldInfo Plus] Save failed', error);
        setStatus('Save failed');
    } finally {
        isSaving = false;
    }
}

async function loadSelectedBook() {
    currentBookName = getSelectedBookName();

    if (!currentBookName) {
        currentData = null;
        renderEmpty('Select a lorebook in World Info first.');
        return;
    }

    setStatus('Loading...');
    currentData = await loadWorldInfo(currentBookName);

    if (!currentData) {
        renderEmpty('Could not load this lorebook.');
        return;
    }

    ensureStore(currentData);
    renderData();
    setStatus(currentBookName);
}

function renderEmpty(message) {
    const list = root.querySelector('.wip-folder-list');
    list.innerHTML = '';
    list.append(createElement('div', 'wip-empty', message));
}

function renderToolbar() {
    const toolbar = createElement('div', 'wip-toolbar');

    const title = createElement('div', 'wip-title', 'WorldInfo Plus');
    const status = createElement('div', 'wip-status', 'Idle');

    const newFolderButton = createElement('button', 'menu_button wip-button', 'New Folder');
    newFolderButton.type = 'button';
    newFolderButton.addEventListener('click', async () => {
        if (!currentData) return;
        const store = ensureStore(currentData);
        const name = prompt('Folder name', `Folder ${store.folders.length + 1}`);
        if (!name) return;

        const id = `folder_${Date.now().toString(36)}`;
        store.folders.push({ id, name: name.trim(), collapsed: false, order: store.folderOrder.length });
        store.folderOrder.push(id);
        store.entryOrder[id] = [];

        renderData();
        await saveCurrentData();
    });

    const refreshButton = createElement('button', 'menu_button wip-button', 'Refresh');
    refreshButton.type = 'button';
    refreshButton.addEventListener('click', loadSelectedBook);

    toolbar.append(title, status, newFolderButton, refreshButton);
    return toolbar;
}

function renderFolder(folder, entries, isUnfiled = false) {
    const store = ensureStore(currentData);
    const card = createElement('section', 'wip-folder-card');
    card.dataset.folderId = folder.id;

    const header = createElement('div', 'wip-folder-header');
    const handle = createElement('span', 'drag-handle wip-folder-handle');
    handle.innerHTML = '&#9776;';

    const toggle = createElement('button', 'wip-folder-toggle', folder.collapsed ? '>' : 'v');
    toggle.type = 'button';
    toggle.addEventListener('click', async () => {
        folder.collapsed = !folder.collapsed;
        renderData();
        await saveCurrentData();
    });

    const name = createElement('button', 'wip-folder-name', folder.name);
    name.type = 'button';
    name.addEventListener('click', () => toggle.click());

    const count = createElement('span', 'wip-folder-count', String(entries.length));

    header.append(handle, toggle, name, count);

    if (!isUnfiled) {
        const renameButton = createElement('button', 'menu_button wip-icon-button', 'Rename');
        renameButton.type = 'button';
        renameButton.addEventListener('click', async () => {
            const nextName = prompt('Folder name', folder.name);
            if (!nextName) return;
            folder.name = nextName.trim();
            renderData();
            await saveCurrentData();
        });

        const deleteButton = createElement('button', 'menu_button wip-icon-button', 'Delete');
        deleteButton.type = 'button';
        deleteButton.addEventListener('click', async () => {
            if (!confirm(`Delete folder "${folder.name}"? Entries will move to Unfiled.`)) return;

            store.folders = store.folders.filter(item => item.id !== folder.id);
            store.folderOrder = store.folderOrder.filter(id => id !== folder.id);
            delete store.entryOrder[folder.id];

            for (const [uid, folderId] of Object.entries(store.entryFolders)) {
                if (folderId === folder.id) {
                    delete store.entryFolders[uid];
                }
            }

            renderData();
            await saveCurrentData();
        });

        header.append(renameButton, deleteButton);
    }

    const entryList = createElement('div', 'wip-entry-list');
    entryList.dataset.folderId = folder.id;

    if (!folder.collapsed) {
        for (const entry of entries) {
            entryList.append(renderEntry(entry));
        }
    }

    card.append(header, entryList);
    return card;
}

function renderEntry(entry) {
    const card = createElement('article', 'wip-entry-card');
    card.dataset.uid = String(entry.uid);

    const handle = createElement('span', 'drag-handle wip-entry-handle');
    handle.innerHTML = '&#9776;';

    const content = createElement('div', 'wip-entry-content');
    const title = createElement('div', 'wip-entry-title', entry.comment?.trim() || `UID ${entry.uid}`);
    const keys = createElement('div', 'wip-entry-keys', Array.isArray(entry.key) ? entry.key.join(', ') : '');

    content.append(title, keys);
    card.append(handle, content);
    return card;
}

function syncFromDom() {
    if (!currentData) return;

    const store = ensureStore(currentData);
    const folderIds = Array.from(root.querySelectorAll('.wip-folder-card[data-folder-id]'))
        .map(element => element.dataset.folderId)
        .filter(id => id && id !== UNFILED_ID);

    store.folderOrder = folderIds;

    for (const folder of store.folders) {
        folder.order = store.folderOrder.indexOf(folder.id);
    }

    for (const list of root.querySelectorAll('.wip-entry-list')) {
        const folderId = list.dataset.folderId;
        const uids = Array.from(list.querySelectorAll('.wip-entry-card[data-uid]')).map(element => element.dataset.uid);
        store.entryOrder[folderId] = uids;

        for (const uid of uids) {
            if (folderId === UNFILED_ID) {
                delete store.entryFolders[uid];
            } else {
                store.entryFolders[uid] = folderId;
            }
        }
    }
}

function enableSorting() {
    if (!window.jQuery || !jQuery.fn.sortable) {
        setStatus('jQuery UI sortable not found');
        return;
    }

    const folderList = jQuery(root.querySelector('.wip-folder-list'));
    if (folderList.sortable('instance')) folderList.sortable('destroy');
    folderList.sortable({
        handle: '.wip-folder-handle',
        items: '.wip-folder-card:not([data-folder-id="__unfiled"])',
        stop: async () => {
            syncFromDom();
            await saveCurrentData();
            renderData();
        },
    });

    for (const list of root.querySelectorAll('.wip-entry-list')) {
        const sortableList = jQuery(list);
        if (sortableList.sortable('instance')) sortableList.sortable('destroy');
        sortableList.sortable({
            connectWith: '.wip-entry-list',
            handle: '.wip-entry-handle',
            placeholder: 'wip-entry-placeholder',
            stop: async () => {
                syncFromDom();
                await saveCurrentData();
                renderData();
            },
        });
    }
}

function renderData() {
    const list = root.querySelector('.wip-folder-list');
    list.innerHTML = '';

    if (!currentData) {
        renderEmpty('No lorebook loaded.');
        return;
    }

    const store = ensureStore(currentData);
    const grouped = groupEntries(currentData, store);

    for (const folder of getOrderedFolders(store)) {
        list.append(renderFolder(folder, grouped[folder.id] ?? []));
    }

    list.append(renderFolder(
        { id: UNFILED_ID, name: 'Unfiled', collapsed: false },
        grouped[UNFILED_ID] ?? [],
        true,
    ));

    enableSorting();
}

function mount() {
    if (document.querySelector('#worldinfo-plus-root')) return;

    const worldInfoPanel = document.querySelector('#WorldInfo');
    const entriesList = document.querySelector('#world_popup_entries_list');
    if (!worldInfoPanel || !entriesList || !worldInfoPanel.contains(entriesList)) {
        setTimeout(mount, 500);
        return;
    }

    root = createElement('div', 'wip-root');
    root.id = 'worldinfo-plus-root';
    root.append(renderToolbar(), createElement('div', 'wip-folder-list'));

    const editorSelect = document.querySelector('#world_editor_select');
    entriesList.insertAdjacentElement('beforebegin', root);
    console.debug('[WorldInfo Plus] Mounted before #world_popup_entries_list');

    editorSelect?.addEventListener('change', loadSelectedBook);
    loadSelectedBook();
}

eventSource.on(event_types.APP_READY, mount);
eventSource.on(event_types.WORLDINFO_UPDATED, (name, data) => {
    if (!root || name !== currentBookName || isSaving) return;
    currentData = data;
    ensureStore(currentData);
    renderData();
});

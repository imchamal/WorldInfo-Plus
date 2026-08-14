import { eventSource, event_types } from '../../../../script.js';
import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';

const MODULE_NAME = 'worldInfoPlus';
const UNFILED_ID = '__unfiled';

let root;
let currentBookName = '';
let currentData = null;
let isSaving = false;
let isOrganizing = false;
let organizeTimer = null;
let loadTimer = null;
let entriesObserver = null;

function createElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function getEntriesList() {
    return document.querySelector('#world_popup_entries_list');
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
    store.unfiledCollapsed = typeof store.unfiledCollapsed === 'boolean' ? store.unfiledCollapsed : false;

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

function setStatus(message) {
    if (!root) return;
    root.querySelector('.wip-status').textContent = message;
}

function isCurrentBookSelected() {
    return !!currentData && !!currentBookName && currentBookName === getSelectedBookName();
}

async function saveCurrentData() {
    if (!isCurrentBookSelected() || isSaving) {
        scheduleLoadSelectedBook();
        return;
    }

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
    installNativeToolbarButton();

    const requestedBookName = getSelectedBookName();

    if (!requestedBookName) {
        currentBookName = '';
        currentData = null;
        renderEmpty('Select a lorebook in World Info first.');
        return;
    }

    setStatus('Loading...');
    const loadedData = await loadWorldInfo(requestedBookName);

    if (getSelectedBookName() !== requestedBookName) {
        scheduleLoadSelectedBook();
        return;
    }

    currentBookName = requestedBookName;
    currentData = loadedData;

    if (!currentData) {
        renderEmpty('Could not load this lorebook.');
        return;
    }

    ensureStore(currentData);
    setStatus(currentBookName);
    scheduleRenderData();
}

function scheduleLoadSelectedBook(delay = 100) {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(() => {
        loadSelectedBook();
    }, delay);
}

async function ensureCurrentDataLoaded() {
    const selectedBookName = getSelectedBookName();
    if (currentData && currentBookName === selectedBookName) {
        return true;
    }

    await loadSelectedBook();
    return !!currentData;
}

function renderEmpty(message) {
    setStatus(message);
    const entriesList = getEntriesList();
    entriesList?.querySelectorAll(':scope > .wip-folder-card').forEach(element => element.remove());
}

function getEntryTitle(entry) {
    const comment = entry.comment?.trim();
    if (comment) return comment;

    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    return keys || `UID ${entry.uid}`;
}

function getEntrySubtitle(entry) {
    const keys = Array.isArray(entry.key) ? entry.key.filter(Boolean).join(', ') : '';
    if (entry.comment?.trim() && keys) return keys;

    return String(entry.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function getUnfiledEntries(data, store) {
    const folderIds = new Set(store.folders.map(folder => folder.id));
    const getSortIndex = entry => {
        const index = Number(entry.displayIndex ?? entry.order ?? entry.uid);
        return Number.isFinite(index) ? index : Number(entry.uid);
    };

    return Object.values(data.entries ?? {})
        .filter(entry => {
            const folderId = store.entryFolders[String(entry.uid)];
            return !folderId || !folderIds.has(folderId);
        })
        .sort((a, b) => {
            const aIndex = getSortIndex(a);
            const bIndex = getSortIndex(b);
            if (aIndex !== bIndex) return aIndex - bIndex;
            return Number(a.uid) - Number(b.uid);
        });
}

function closeDialog(dialog, result) {
    dialog.remove();
    return result;
}

function showCreateFolderDialog(defaultName, unfiledEntries) {
    return new Promise(resolve => {
        const overlay = createElement('div', 'wip-dialog-overlay');
        const dialog = createElement('div', 'wip-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const title = createElement('div', 'wip-dialog-title', '새 폴더');
        const nameInput = createElement('input', 'text_pole wip-folder-input');
        nameInput.type = 'text';
        nameInput.value = defaultName;
        nameInput.placeholder = 'Folder name';

        const selectAllRow = createElement('label', 'wip-dialog-select-row');
        const selectAllCheckbox = createElement('input');
        selectAllCheckbox.type = 'checkbox';
        const summary = createElement('span', 'wip-dialog-summary', `미분류 항목 ${unfiledEntries.length}개`);
        selectAllRow.append(selectAllCheckbox, summary);

        const list = createElement('div', 'wip-dialog-entry-list');
        const entryCheckboxes = [];

        if (!unfiledEntries.length) {
            list.append(createElement('div', 'wip-dialog-empty', '미분류 항목이 없습니다. 빈 폴더를 생성합니다.'));
        }

        for (const entry of unfiledEntries) {
            const uid = String(entry.uid);
            const row = createElement('label', 'wip-dialog-entry');
            const checkbox = createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = uid;
            entryCheckboxes.push(checkbox);

            const text = createElement('span', 'wip-dialog-entry-text');
            const entryTitle = createElement('span', 'wip-dialog-entry-title', getEntryTitle(entry));
            const subtitle = getEntrySubtitle(entry);
            text.append(entryTitle);

            if (subtitle) {
                text.append(createElement('span', 'wip-dialog-entry-subtitle', subtitle));
            }

            row.append(checkbox, text);
            list.append(row);
        }

        const footer = createElement('div', 'wip-dialog-footer');
        const cancelButton = createElement('button', 'menu_button', '취소');
        const createButton = createElement('button', 'menu_button', '생성');
        cancelButton.type = 'button';
        createButton.type = 'button';
        footer.append(cancelButton, createButton);

        const finish = result => {
            document.removeEventListener('keydown', onKeyDown);
            resolve(closeDialog(overlay, result));
        };

        const getSelectedUids = () => entryCheckboxes
            .filter(checkbox => checkbox.checked)
            .map(checkbox => checkbox.value);

        const updateSelectAllState = () => {
            const checkedCount = entryCheckboxes.filter(checkbox => checkbox.checked).length;
            selectAllCheckbox.checked = !!entryCheckboxes.length && checkedCount === entryCheckboxes.length;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < entryCheckboxes.length;
        };

        function onKeyDown(event) {
            if (event.key === 'Escape') {
                event.stopPropagation();
                finish(null);
            }
        }

        for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click', 'keydown']) {
            overlay.addEventListener(eventName, event => {
                event.stopPropagation();
            });
        }

        selectAllCheckbox.addEventListener('change', () => {
            for (const checkbox of entryCheckboxes) {
                checkbox.checked = selectAllCheckbox.checked;
            }
            updateSelectAllState();
        });

        for (const checkbox of entryCheckboxes) {
            checkbox.addEventListener('change', updateSelectAllState);
        }

        cancelButton.addEventListener('click', event => {
            event.stopPropagation();
            finish(null);
        });

        nameInput.addEventListener('keydown', event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            event.stopPropagation();
            createButton.click();
        });

        createButton.addEventListener('click', event => {
            event.stopPropagation();
            const name = nameInput.value.trim();
            if (!name) {
                nameInput.focus();
                return;
            }

            finish({ name, selectedUids: getSelectedUids() });
        });

        document.addEventListener('keydown', onKeyDown);
        dialog.append(title, nameInput, selectAllRow, list, footer);
        overlay.append(dialog);
        (document.querySelector('#WorldInfo') || document.body).append(overlay);
        updateSelectAllState();
        nameInput.focus();
        nameInput.select();
    });
}

async function createFolder() {
    if (!await ensureCurrentDataLoaded()) {
        setStatus('Select a lorebook first.');
        return;
    }

    const store = ensureStore(currentData);
    const result = await showCreateFolderDialog(`Folder ${store.folders.length + 1}`, getUnfiledEntries(currentData, store));
    if (!result) return;

    const id = `folder_${Date.now().toString(36)}`;
    store.folders.push({ id, name: result.name, collapsed: false, order: store.folderOrder.length });
    store.folderOrder.push(id);
    store.entryOrder[id] = result.selectedUids;

    for (const uid of result.selectedUids) {
        store.entryFolders[uid] = id;
    }

    renderData();
    await saveCurrentData();
}

function bindButtonActivation(button, handler) {
    button.addEventListener('click', handler);
    button.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        button.click();
    });
}

function createIconButton(id, iconClass, title, handler) {
    const button = createElement('div', `menu_button fa-solid ${iconClass} interactable wip-icon-button`);
    button.id = id;
    button.title = title;
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    bindButtonActivation(button, handler);
    return button;
}

function renderToolbar() {
    const toolbar = createElement('div', 'wip-toolbar');
    const status = createElement('div', 'wip-status', 'Idle');
    toolbar.append(status);
    return toolbar;
}

function installNativeToolbarButton() {
    if (document.querySelector('#worldinfo_plus_new_folder')) return;

    const newEntryButton = document.querySelector('#world_popup_new');
    if (!newEntryButton) {
        setTimeout(installNativeToolbarButton, 500);
        return;
    }

    const newFolderButton = createIconButton(
        'worldinfo_plus_new_folder',
        'fa-folder-plus',
        '새 폴더',
        createFolder,
    );

    newEntryButton.insertAdjacentElement('afterend', newFolderButton);
}

function getEntryUid(element) {
    return String(element.dataset.uid || element.getAttribute('uid') || '');
}

function ensureEntryFolderHandle(entry) {
    let handle = entry.querySelector(':scope .wip-entry-handle');
    if (handle) return;

    handle = entry.querySelector(':scope .drag-handle');
    if (handle) {
        handle.classList.add('wip-entry-handle');
        return;
    }

    handle = createElement('span', 'drag-handle wip-entry-handle');
    handle.innerHTML = '&#9776;';

    const header = entry.querySelector('.inline-drawer-header') || entry.querySelector('.world_entry_form') || entry;
    header.prepend(handle);
}

function collectRenderedEntries(entriesList) {
    return Array.from(entriesList.querySelectorAll('.world_entry'))
        .filter(entry => !entry.closest('#entry_edit_template'))
        .filter(entry => getEntryUid(entry));
}

function orderEntryNodes(nodes, folderId, store) {
    const order = store.entryOrder[folderId] ?? [];
    const index = new Map(order.map((uid, position) => [String(uid), position]));

    return [...nodes].sort((a, b) => {
        const aUid = getEntryUid(a);
        const bUid = getEntryUid(b);
        const aIndex = index.has(aUid) ? index.get(aUid) : Number.MAX_SAFE_INTEGER;
        const bIndex = index.has(bUid) ? index.get(bUid) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;
        return Number(aUid) - Number(bUid);
    });
}

function renderFolder(folder, entries, isUnfiled = false) {
    const store = ensureStore(currentData);
    const card = createElement('section', 'wip-folder-card');
    card.dataset.folderId = folder.id;
    card.dataset.collapsed = folder.collapsed ? 'true' : 'false';

    const header = createElement('div', 'wip-folder-header');
    const handle = createElement('span', 'drag-handle wip-folder-handle');
    handle.innerHTML = '&#9776;';

    const toggle = createIconButton(
        '',
        folder.collapsed ? 'fa-circle-chevron-down' : 'fa-circle-chevron-up',
        folder.collapsed ? '폴더 펼치기' : '폴더 접기',
        async () => {
            if (isUnfiled) {
                store.unfiledCollapsed = !store.unfiledCollapsed;
            } else {
                folder.collapsed = !folder.collapsed;
            }

            renderData();
            await saveCurrentData();
        },
    );
    toggle.removeAttribute('id');
    toggle.classList.add('wip-folder-toggle');
    toggle.classList.remove('menu_button');

    const name = createElement('button', 'wip-folder-name', folder.name);
    name.type = 'button';
    name.addEventListener('click', () => toggle.click());

    const count = createElement('span', 'wip-folder-count', String(entries.length));

    header.append(handle, toggle, name, count);

    if (!isUnfiled) {
        const renameButton = createIconButton(
            '',
            'fa-pencil',
            '폴더 이름 변경',
            async () => {
                const nextName = prompt('Folder name', folder.name);
                if (!nextName) return;
                folder.name = nextName.trim();
                renderData();
                await saveCurrentData();
            },
        );
        renameButton.removeAttribute('id');

        const deleteButton = createIconButton(
            '',
            'fa-trash-can',
            '폴더 삭제',
            async () => {
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
            },
        );
        deleteButton.removeAttribute('id');

        header.append(renameButton, deleteButton);
    }

    const entryList = createElement('div', 'wip-entry-list');
    entryList.dataset.folderId = folder.id;
    entryList.hidden = !!folder.collapsed || entries.length === 0;

    for (const entry of entries) {
        ensureEntryFolderHandle(entry);
        entryList.append(entry);
    }

    card.append(header, entryList);
    return card;
}

function syncFromDom() {
    if (!isCurrentBookSelected()) {
        scheduleLoadSelectedBook();
        return;
    }

    const entriesList = getEntriesList();
    if (!entriesList) return;

    const store = ensureStore(currentData);
    const folderIds = Array.from(entriesList.querySelectorAll(':scope > .wip-folder-card[data-folder-id]'))
        .map(element => element.dataset.folderId)
        .filter(id => id && id !== UNFILED_ID);

    store.folderOrder = folderIds;

    for (const folder of store.folders) {
        folder.order = store.folderOrder.indexOf(folder.id);
    }

    for (const list of entriesList.querySelectorAll('.wip-entry-list')) {
        const folderId = list.dataset.folderId;
        const uids = Array.from(list.querySelectorAll('.world_entry')).map(element => getEntryUid(element)).filter(Boolean);
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

    const entriesList = getEntriesList();
    if (!entriesList) return;

    const folderList = jQuery(entriesList);
    if (folderList.sortable('instance')) folderList.sortable('destroy');
    folderList.sortable({
        handle: '.wip-folder-handle',
        items: '> .wip-folder-card:not([data-folder-id="__unfiled"])',
        cancel: '.wip-entry-list, .world_entry, input, textarea, select, button, .menu_button',
        helper: (_, item) => {
            const helper = item.clone();
            helper.find('.wip-entry-list').remove();
            helper.addClass('wip-folder-sort-helper');
            helper.width(item.outerWidth());
            return helper;
        },
        placeholder: 'wip-folder-placeholder',
        forcePlaceholderSize: true,
        stop: async () => {
            syncFromDom();
            await saveCurrentData();
            renderData();
        },
    });

    for (const list of entriesList.querySelectorAll('.wip-entry-list')) {
        const sortableList = jQuery(list);
        if (sortableList.sortable('instance')) sortableList.sortable('destroy');
        sortableList.sortable({
            connectWith: '#world_popup_entries_list .wip-entry-list',
            handle: '.wip-entry-handle',
            items: '> .world_entry',
            helper: (_, item) => {
                const helper = item.clone();
                helper.addClass('wip-entry-sort-helper');
                helper.width(item.outerWidth());
                return helper;
            },
            placeholder: 'wip-entry-placeholder',
            forcePlaceholderSize: true,
            stop: async (_, ui) => {
                if (ui.item?.data('wipFolderDropPending')) return;

                syncFromDom();
                await saveCurrentData();
                renderData();
            },
        });
    }

    if (!jQuery.fn.droppable) return;

    for (const header of entriesList.querySelectorAll('.wip-folder-header')) {
        const droppableHeader = jQuery(header);
        if (droppableHeader.droppable('instance')) droppableHeader.droppable('destroy');

        const targetFolder = header.closest('.wip-folder-card');
        const targetList = targetFolder?.querySelector(':scope > .wip-entry-list');
        if (!targetList?.hidden) continue;

        droppableHeader.droppable({
            accept: '.world_entry',
            hoverClass: 'wip-folder-drop-hover',
            tolerance: 'pointer',
            drop: async (_, ui) => {
                const draggedEntry = ui.draggable?.[0];

                if (!draggedEntry?.classList.contains('world_entry') || targetList.contains(draggedEntry)) {
                    return;
                }

                ui.draggable.data('wipFolderDropPending', true);
                setTimeout(async () => {
                    ui.draggable.removeData('wipFolderDropPending');
                    targetList.append(draggedEntry);
                    syncFromDom();
                    await saveCurrentData();
                    renderData();
                }, 0);
            },
        });
    }
}

function scheduleRenderData(delay = 80) {
    clearTimeout(organizeTimer);
    organizeTimer = setTimeout(() => {
        if (currentData) {
            renderData();
        }
    }, delay);
}

function renderData() {
    const entriesList = getEntriesList();
    if (isOrganizing) return;

    if (!currentData || !entriesList) {
        renderEmpty('No lorebook loaded.');
        return;
    }

    if (!isCurrentBookSelected()) {
        scheduleLoadSelectedBook();
        return;
    }

    const renderedEntries = collectRenderedEntries(entriesList);
    if (!renderedEntries.length) return;

    isOrganizing = true;

    const store = ensureStore(currentData);
    const folderIds = new Set(store.folders.map(folder => folder.id));
    const grouped = { [UNFILED_ID]: [] };

    for (const folder of store.folders) {
        grouped[folder.id] = [];
    }

    for (const entry of renderedEntries) {
        const uid = getEntryUid(entry);
        const folderId = store.entryFolders[uid];
        if (folderId && folderIds.has(folderId)) {
            grouped[folderId].push(entry);
        } else {
            grouped[UNFILED_ID].push(entry);
        }
    }

    const oldFolders = Array.from(entriesList.querySelectorAll(':scope > .wip-folder-card'));

    try {
        const fragment = document.createDocumentFragment();

        for (const folder of getOrderedFolders(store)) {
            const entries = orderEntryNodes(grouped[folder.id] ?? [], folder.id, store);
            fragment.append(renderFolder(folder, entries));
        }

        fragment.append(renderFolder(
            { id: UNFILED_ID, name: 'Unfiled', collapsed: store.unfiledCollapsed },
            orderEntryNodes(grouped[UNFILED_ID] ?? [], UNFILED_ID, store),
            true,
        ));

        oldFolders.forEach(element => element.remove());
        entriesList.append(fragment);
        enableSorting();
    } finally {
        setTimeout(() => {
            isOrganizing = false;
        }, 0);
    }
}

function observeEntriesList(entriesList) {
    entriesObserver?.disconnect();
    entriesObserver = new MutationObserver(() => {
        if (isOrganizing) return;
        if (!isCurrentBookSelected()) {
            scheduleLoadSelectedBook();
            return;
        }

        scheduleRenderData();
    });
    entriesObserver.observe(entriesList, { childList: true });
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
    root.append(renderToolbar());

    const editorSelect = document.querySelector('#world_editor_select');
    entriesList.insertAdjacentElement('beforebegin', root);
    installNativeToolbarButton();
    observeEntriesList(entriesList);
    console.debug('[WorldInfo Plus] Mounted before #world_popup_entries_list');

    editorSelect?.addEventListener('change', loadSelectedBook);
    loadSelectedBook();
    scheduleLoadSelectedBook(500);
}

eventSource.on(event_types.APP_READY, mount);
eventSource.on(event_types.WORLDINFO_UPDATED, (name, data) => {
    if (!root || name !== currentBookName || isSaving) return;
    currentData = data;
    ensureStore(currentData);
    scheduleRenderData();
});

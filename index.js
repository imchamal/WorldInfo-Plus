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
let entryMoveMenu = null;

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

function getFolderOptions(store) {
    return [
        { id: UNFILED_ID, name: 'Unfiled' },
        ...getOrderedFolders(store).map(folder => ({ id: folder.id, name: folder.name })),
    ];
}

function getFolderDisplayName(store, folderId) {
    if (folderId === UNFILED_ID) return 'Unfiled';
    return store.folders.find(folder => folder.id === folderId)?.name || 'Unknown folder';
}

function orderDataEntries(entries, folderId, store) {
    const order = store.entryOrder[folderId] ?? [];
    const index = new Map(order.map((uid, position) => [String(uid), position]));
    const getSortIndex = entry => {
        const value = Number(entry.displayIndex ?? entry.order ?? entry.uid);
        return Number.isFinite(value) ? value : Number(entry.uid);
    };

    return [...entries].sort((a, b) => {
        const aUid = String(a.uid);
        const bUid = String(b.uid);
        const aIndex = index.has(aUid) ? index.get(aUid) : Number.MAX_SAFE_INTEGER;
        const bIndex = index.has(bUid) ? index.get(bUid) : Number.MAX_SAFE_INTEGER;
        if (aIndex !== bIndex) return aIndex - bIndex;

        const aFallback = getSortIndex(a);
        const bFallback = getSortIndex(b);
        if (aFallback !== bFallback) return aFallback - bFallback;

        return Number(a.uid) - Number(b.uid);
    });
}

function getEntriesInFolder(data, store, folderId) {
    const folderIds = new Set(store.folders.map(folder => folder.id));
    const entries = Object.values(data.entries ?? {}).filter(entry => {
        const assignedFolderId = store.entryFolders[String(entry.uid)];

        if (folderId === UNFILED_ID) {
            return !assignedFolderId || !folderIds.has(assignedFolderId);
        }

        return assignedFolderId === folderId;
    });

    return orderDataEntries(entries, folderId, store);
}

function closeDialog(dialog, result) {
    dialog.remove();
    return result;
}

function closeEntryMoveMenu() {
    entryMoveMenu?.remove();
    entryMoveMenu = null;
    document.removeEventListener('pointerdown', handleEntryMoveMenuOutsideClick);
    document.removeEventListener('scroll', closeEntryMoveMenu, true);
    window.removeEventListener('resize', closeEntryMoveMenu);
}

function handleEntryMoveMenuOutsideClick(event) {
    if (entryMoveMenu?.contains(event.target)) return;
    if (event.target?.closest?.('.wip-entry-move-folder')) return;
    closeEntryMoveMenu();
}

function getEntryMoveMenuContainer() {
    const worldInfoPanel = document.querySelector('#WorldInfo');
    if (!worldInfoPanel) return document.body;

    if (getComputedStyle(worldInfoPanel).position === 'static') {
        worldInfoPanel.classList.add('wip-entry-menu-anchor');
    }

    return worldInfoPanel;
}

function positionEntryMoveMenu(button, menu, container) {
    const margin = 8;
    const gap = 4;
    const buttonRect = button.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const isBody = container === document.body;
    const containerRect = isBody
        ? { top: 0, left: 0 }
        : container.getBoundingClientRect();
    const scrollLeft = isBody ? window.scrollX : container.scrollLeft;
    const scrollTop = isBody ? window.scrollY : container.scrollTop;
    const visibleWidth = isBody ? viewportWidth : container.clientWidth;
    const visibleHeight = isBody ? viewportHeight : container.clientHeight;
    const maxLeft = Math.max(scrollLeft + margin, scrollLeft + visibleWidth - menuRect.width - margin);
    const maxTop = Math.max(scrollTop + margin, scrollTop + visibleHeight - menuRect.height - margin);

    let left = buttonRect.right - containerRect.left + scrollLeft - menuRect.width;
    let top = buttonRect.bottom - containerRect.top + scrollTop + gap;

    if (top - scrollTop + menuRect.height > visibleHeight - margin) {
        top = buttonRect.top - containerRect.top + scrollTop - menuRect.height - gap;
    }

    menu.style.left = `${Math.max(scrollLeft + margin, Math.min(left, maxLeft))}px`;
    menu.style.top = `${Math.max(scrollTop + margin, Math.min(top, maxTop))}px`;
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

function showFolderManageDialog(initialTargetFolderId) {
    return new Promise(resolve => {
        const store = ensureStore(currentData);
        const folderOptions = getFolderOptions(store);
        const initialTargetOption = folderOptions.some(option => option.id === initialTargetFolderId)
            ? initialTargetFolderId
            : UNFILED_ID;

        const overlay = createElement('div', 'wip-dialog-overlay');
        const dialog = createElement('div', 'wip-dialog wip-manage-dialog');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');

        const title = createElement('div', 'wip-dialog-title', '폴더 관리');

        const targetRow = createElement('label', 'wip-dialog-control-row');
        const targetLabel = createElement('span', 'wip-dialog-row-label', '이동 대상');
        const targetSelect = createElement('select', 'text_pole textarea_compact wip-dialog-select');
        targetRow.append(targetLabel, targetSelect);

        const filterRow = createElement('label', 'wip-dialog-control-row');
        const filterLabel = createElement('span', 'wip-dialog-row-label', '보기');
        const filterSelect = createElement('select', 'text_pole textarea_compact wip-dialog-select');
        filterRow.append(filterLabel, filterSelect);

        const searchInput = createElement('input', 'text_pole textarea_compact wip-dialog-search');
        searchInput.type = 'search';
        searchInput.placeholder = '검색...';

        const selectAllRow = createElement('label', 'wip-dialog-select-row');
        const selectAllCheckbox = createElement('input');
        selectAllCheckbox.type = 'checkbox';
        const summary = createElement('span', 'wip-dialog-summary');
        selectAllRow.append(selectAllCheckbox, summary);

        const list = createElement('div', 'wip-dialog-entry-list');
        const footer = createElement('div', 'wip-dialog-footer');
        const cancelButton = createElement('button', 'menu_button', '취소');
        const moveButton = createElement('button', 'menu_button', '선택 이동');
        cancelButton.type = 'button';
        moveButton.type = 'button';
        footer.append(cancelButton, moveButton);

        let entryCheckboxes = [];

        const finish = result => {
            document.removeEventListener('keydown', onKeyDown);
            resolve(closeDialog(overlay, result));
        };

        const getEntryFolderId = entry => {
            const folderIds = new Set(store.folders.map(folder => folder.id));
            const folderId = store.entryFolders[String(entry.uid)];
            return folderId && folderIds.has(folderId) ? folderId : UNFILED_ID;
        };

        const getSelectedUids = () => entryCheckboxes
            .filter(checkbox => checkbox.checked)
            .map(checkbox => checkbox.value);

        const entryMatchesSearch = entry => {
            const query = searchInput.value.trim().toLowerCase();
            if (!query) return true;

            const folderName = getFolderDisplayName(store, getEntryFolderId(entry));
            return [
                getEntryTitle(entry),
                getEntrySubtitle(entry),
                folderName,
            ].some(value => String(value).toLowerCase().includes(query));
        };

        const updateSelectAllState = () => {
            const checkedCount = entryCheckboxes.filter(checkbox => checkbox.checked).length;
            selectAllCheckbox.disabled = !entryCheckboxes.length;
            selectAllCheckbox.checked = !!entryCheckboxes.length && checkedCount === entryCheckboxes.length;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < entryCheckboxes.length;
            moveButton.disabled = checkedCount === 0 || !targetSelect.value;
        };

        const fillTargetOptions = () => {
            targetSelect.replaceChildren();

            for (const option of folderOptions) {
                const element = document.createElement('option');
                element.value = option.id;
                element.textContent = option.name;
                targetSelect.append(element);
            }

            targetSelect.value = initialTargetOption;
        };

        const fillFilterOptions = () => {
            const previousValue = filterSelect.value || '__all';
            filterSelect.replaceChildren();

            const allOption = document.createElement('option');
            allOption.value = '__all';
            allOption.textContent = '전체';
            filterSelect.append(allOption);

            for (const option of folderOptions) {
                const element = document.createElement('option');
                element.value = option.id;
                element.textContent = option.name;
                filterSelect.append(element);
            }

            filterSelect.value = ['__all', ...folderOptions.map(option => option.id)].includes(previousValue)
                ? previousValue
                : '__all';
        };

        const renderEntryList = () => {
            const targetFolderId = targetSelect.value || UNFILED_ID;
            const filterFolderId = filterSelect.value || '__all';
            const entries = Object.values(currentData.entries ?? {})
                .filter(entry => {
                    const currentFolderId = getEntryFolderId(entry);
                    if (currentFolderId === targetFolderId) return false;
                    if (filterFolderId !== '__all' && currentFolderId !== filterFolderId) return false;
                    return entryMatchesSearch(entry);
                })
                .sort((a, b) => {
                    const aFolderId = getEntryFolderId(a);
                    const bFolderId = getEntryFolderId(b);
                    if (aFolderId !== bFolderId) {
                        return getFolderDisplayName(store, aFolderId)
                            .localeCompare(getFolderDisplayName(store, bFolderId));
                    }

                    return orderDataEntries([a, b], aFolderId, store)[0] === a ? -1 : 1;
                });

            entryCheckboxes = [];
            list.replaceChildren();
            summary.textContent = `${getFolderDisplayName(store, targetFolderId)}로 이동할 수 있는 항목 ${entries.length}개`;

            if (!entries.length) {
                list.append(createElement('div', 'wip-dialog-empty', '이 조건에 맞는 이동 가능 항목이 없습니다.'));
                updateSelectAllState();
                return;
            }

            for (const entry of entries) {
                const uid = String(entry.uid);
                const folderName = getFolderDisplayName(store, getEntryFolderId(entry));
                const row = createElement('label', 'wip-dialog-entry');
                const checkbox = createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = uid;
                entryCheckboxes.push(checkbox);

                const text = createElement('span', 'wip-dialog-entry-text');
                const titleRow = createElement('span', 'wip-dialog-entry-title-row');
                const entryTitle = createElement('span', 'wip-dialog-entry-title', getEntryTitle(entry));
                const folderBadge = createElement('span', 'wip-folder-badge', folderName);
                const subtitle = getEntrySubtitle(entry);
                titleRow.append(entryTitle, folderBadge);
                text.append(titleRow);

                if (subtitle) {
                    text.append(createElement('span', 'wip-dialog-entry-subtitle', subtitle));
                }

                checkbox.addEventListener('change', updateSelectAllState);
                row.append(checkbox, text);
                list.append(row);
            }

            updateSelectAllState();
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

        targetSelect.addEventListener('change', renderEntryList);
        filterSelect.addEventListener('change', renderEntryList);
        searchInput.addEventListener('input', renderEntryList);

        selectAllCheckbox.addEventListener('change', () => {
            for (const checkbox of entryCheckboxes) {
                checkbox.checked = selectAllCheckbox.checked;
            }
            updateSelectAllState();
        });

        cancelButton.addEventListener('click', event => {
            event.stopPropagation();
            finish(null);
        });

        moveButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const selectedUids = getSelectedUids();
            if (!selectedUids.length || !targetSelect.value) return;
            finish({ selectedUids, targetFolderId: targetSelect.value });
        });

        document.addEventListener('keydown', onKeyDown);
        dialog.append(title, targetRow, filterRow, searchInput, selectAllRow, list, footer);
        overlay.append(dialog);
        (document.querySelector('#WorldInfo') || document.body).append(overlay);

        fillTargetOptions();
        fillFilterOptions();
        renderEntryList();
        targetSelect.focus();
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
    const newEntryButton = document.querySelector('#world_popup_new');
    if (!newEntryButton) {
        setTimeout(installNativeToolbarButton, 500);
        return;
    }

    let newFolderButton = document.querySelector('#worldinfo_plus_new_folder');
    if (!newFolderButton) {
        newFolderButton = createIconButton(
            'worldinfo_plus_new_folder',
            'fa-folder-plus',
            '새 폴더',
            createFolder,
        );

        newEntryButton.insertAdjacentElement('afterend', newFolderButton);
    }

    if (document.querySelector('#worldinfo_plus_manage_folders')) return;

    const manageFoldersButton = createIconButton(
        'worldinfo_plus_manage_folders',
        'fa-list-check',
        '폴더 항목 관리',
        () => manageFolderEntries(),
    );

    newFolderButton.insertAdjacentElement('afterend', manageFoldersButton);
}

function getEntryUid(element) {
    return String(element.dataset.uid || element.getAttribute('uid') || '');
}

async function moveEntryToFolder(uid, targetFolderId) {
    await moveEntriesToFolder([uid], targetFolderId);
}

async function moveEntriesToFolder(uids, targetFolderId) {
    const normalizedUids = [...new Set(uids.map(uid => String(uid)).filter(Boolean))];
    if (!normalizedUids.length) return;

    if (!isCurrentBookSelected()) {
        scheduleLoadSelectedBook();
        return;
    }

    syncFromDom();

    const store = ensureStore(currentData);
    const validFolderIds = new Set(store.folders.map(folder => folder.id));
    const normalizedTargetFolderId = validFolderIds.has(targetFolderId) ? targetFolderId : UNFILED_ID;
    const movingUidSet = new Set(normalizedUids);

    for (const folderId of Object.keys(store.entryOrder)) {
        store.entryOrder[folderId] = store.entryOrder[folderId]
            .filter(entryUid => !movingUidSet.has(String(entryUid)));
    }

    if (normalizedTargetFolderId === UNFILED_ID) {
        for (const uid of normalizedUids) {
            delete store.entryFolders[uid];
        }
        store.entryOrder[UNFILED_ID].push(...normalizedUids);
    } else {
        store.entryOrder[normalizedTargetFolderId] = Array.isArray(store.entryOrder[normalizedTargetFolderId])
            ? store.entryOrder[normalizedTargetFolderId]
            : [];

        for (const uid of normalizedUids) {
            store.entryFolders[uid] = normalizedTargetFolderId;
        }

        store.entryOrder[normalizedTargetFolderId].push(...normalizedUids);
    }

    renderData();
    await saveCurrentData();
}

async function manageFolderEntries(initialTargetFolderId = '') {
    closeEntryMoveMenu();

    if (!await ensureCurrentDataLoaded()) {
        setStatus('Select a lorebook first.');
        return;
    }

    syncFromDom();
    const store = ensureStore(currentData);
    const fallbackTargetFolderId = getOrderedFolders(store)[0]?.id || UNFILED_ID;
    const preferredTargetFolderId = initialTargetFolderId || fallbackTargetFolderId;
    const folderExists = preferredTargetFolderId === UNFILED_ID || store.folders.some(folder => folder.id === preferredTargetFolderId);
    const result = await showFolderManageDialog(folderExists ? preferredTargetFolderId : fallbackTargetFolderId);
    if (!result) return;

    await moveEntriesToFolder(result.selectedUids, result.targetFolderId);
}

function showEntryMoveMenu(button, uid) {
    closeEntryMoveMenu();

    if (!currentData) return;

    const store = ensureStore(currentData);
    const currentFolderId = store.entryFolders[String(uid)] || UNFILED_ID;
    const menu = createElement('div', 'wip-entry-move-menu');

    for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'keydown']) {
        menu.addEventListener(eventName, event => {
            event.stopPropagation();
        });
    }

    const addOption = (folderId, label) => {
        const option = createElement('button', 'wip-entry-move-option');
        option.type = 'button';
        option.dataset.folderId = folderId;

        const check = createElement('span', 'fa-solid fa-check wip-entry-move-check');
        const isCurrentFolder = folderId === currentFolderId;
        check.classList.toggle('wip-entry-move-check-active', isCurrentFolder);
        option.disabled = isCurrentFolder;

        const text = createElement('span', 'wip-entry-move-label', label);
        option.append(check, text);
        option.addEventListener('click', async event => {
            event.preventDefault();
            event.stopPropagation();
            closeEntryMoveMenu();
            await moveEntryToFolder(uid, folderId);
        });

        menu.append(option);
    };

    addOption(UNFILED_ID, 'Unfiled');

    for (const folder of getOrderedFolders(store)) {
        addOption(folder.id, folder.name);
    }

    entryMoveMenu = menu;
    const container = getEntryMoveMenuContainer();
    container.append(menu);
    positionEntryMoveMenu(button, menu, container);

    setTimeout(() => {
        document.addEventListener('pointerdown', handleEntryMoveMenuOutsideClick);
        document.addEventListener('scroll', closeEntryMoveMenu, true);
        window.addEventListener('resize', closeEntryMoveMenu);
    }, 0);
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

function ensureEntryMoveButton(entry) {
    if (entry.querySelector(':scope .wip-entry-move-folder')) return;

    const uid = getEntryUid(entry);
    if (!uid) return;

    const button = createElement('i', 'menu_button fa-solid fa-folder-open wip-entry-move-folder');
    button.title = '폴더로 이동';
    button.tabIndex = 0;
    button.setAttribute('role', 'button');
    bindButtonActivation(button, event => {
        event?.stopPropagation?.();
        showEntryMoveMenu(button, uid);
    });

    const existingMoveButton = entry.querySelector(':scope .move_entry_button');
    const duplicateButton = entry.querySelector(':scope .duplicate_entry_button');
    const header = entry.querySelector(':scope .inline-drawer-header') || entry;

    if (existingMoveButton) {
        existingMoveButton.insertAdjacentElement('afterend', button);
    } else if (duplicateButton) {
        duplicateButton.insertAdjacentElement('beforebegin', button);
    } else {
        header.append(button);
    }
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
        ensureEntryMoveButton(entry);
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
    enableFolderDragging(entriesList);

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
            stop: async () => {
                syncFromDom();
                await saveCurrentData();
                renderData();
            },
        });
    }
}

function enableFolderDragging(entriesList) {
    const folderCards = Array.from(entriesList.querySelectorAll(':scope > .wip-folder-card:not([data-folder-id="__unfiled"])'));

    for (const card of folderCards) {
        const handle = card.querySelector(':scope > .wip-folder-header > .wip-folder-handle');
        if (!handle) continue;

        handle.draggable = true;
        handle.addEventListener('dragstart', event => {
            event.stopPropagation();
            card.classList.add('wip-folder-dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', card.dataset.folderId || '');
        });

        handle.addEventListener('dragend', async event => {
            event.stopPropagation();
            entriesList.querySelectorAll('.wip-folder-dragging, .wip-folder-drag-over').forEach(element => {
                element.classList.remove('wip-folder-dragging', 'wip-folder-drag-over');
            });

            syncFromDom();
            await saveCurrentData();
            renderData();
        });

        card.addEventListener('dragover', event => {
            const draggedCard = entriesList.querySelector(':scope > .wip-folder-card.wip-folder-dragging');
            if (!draggedCard || draggedCard === card) return;

            event.preventDefault();
            event.stopPropagation();

            const rect = card.getBoundingClientRect();
            const insertAfter = event.clientY > rect.top + rect.height / 2;
            card.classList.add('wip-folder-drag-over');

            if (insertAfter) {
                card.insertAdjacentElement('afterend', draggedCard);
            } else {
                card.insertAdjacentElement('beforebegin', draggedCard);
            }
        });

        card.addEventListener('dragleave', event => {
            if (card.contains(event.relatedTarget)) return;
            card.classList.remove('wip-folder-drag-over');
        });

        card.addEventListener('drop', event => {
            event.preventDefault();
            event.stopPropagation();
            card.classList.remove('wip-folder-drag-over');
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
    closeEntryMoveMenu();

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

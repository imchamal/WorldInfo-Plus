import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';
import { getSelect2OptionId } from '../../../utils.js';
import { loadWorldInfo, saveWorldInfo, splitKeywordsAndRegexes } from '../../../world-info.js';

const MODULE_NAME = 'worldInfoPlus';
const UNFILED_ID = '__unfiled';
const DEFAULT_SETTINGS = {
    translationProvider: 'google',
    targetLanguage: 'ko',
    profileId: '',
};
const LANGUAGE_OPTIONS = [
    ['ko', 'Korean'],
    ['en', 'English'],
    ['ja', 'Japanese'],
    ['zh-CN', 'Chinese (Simplified)'],
    ['zh-TW', 'Chinese (Traditional)'],
    ['es', 'Spanish'],
    ['fr', 'French'],
    ['de', 'German'],
    ['ru', 'Russian'],
];
const ENTRY_TABS = [
    { id: 'content', label: '본문' },
    { id: 'activation', label: '발동·삽입' },
    { id: 'filters', label: '필터' },
    { id: 'advanced', label: '고급' },
];

let root;
let currentBookName = '';
let currentData = null;
let isSaving = false;
let isOrganizing = false;
let organizeTimer = null;
let loadTimer = null;
let entriesObserver = null;
let entryMoveMenu = null;
let settingsProfileSelect = null;
let settingsProfileEventsBound = false;
let googleTranslateModulePromise = null;
let connectionRequestServicePromise = null;
let entryTabIdCounter = 0;
const entryTabOpenHandlers = new WeakSet();

function createElement(tag, className = '', text = '') {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
}

function ensureSettings() {
    extension_settings[MODULE_NAME] ??= {};
    Object.assign(extension_settings[MODULE_NAME], {
        ...DEFAULT_SETTINGS,
        ...extension_settings[MODULE_NAME],
    });

    if (!['google', 'profile'].includes(extension_settings[MODULE_NAME].translationProvider)) {
        extension_settings[MODULE_NAME].translationProvider = DEFAULT_SETTINGS.translationProvider;
    }

    if (typeof extension_settings[MODULE_NAME].targetLanguage !== 'string' || !extension_settings[MODULE_NAME].targetLanguage.trim()) {
        extension_settings[MODULE_NAME].targetLanguage = DEFAULT_SETTINGS.targetLanguage;
    }

    return extension_settings[MODULE_NAME];
}

function notify(type, message, title = 'WorldInfo Plus') {
    const toast = globalThis.toastr?.[type];
    if (typeof toast === 'function') {
        toast(message, title);
        return;
    }

    const logger = type === 'error' ? console.error : console.info;
    logger(`[WorldInfo Plus] ${message}`);
}

function getLanguageLabel(languageCode) {
    const option = LANGUAGE_OPTIONS.find(([code]) => code === languageCode);
    return option ? `${option[1]} (${option[0]})` : languageCode;
}

function getConnectionProfiles() {
    return Array.isArray(extension_settings.connectionManager?.profiles)
        ? extension_settings.connectionManager.profiles
        : [];
}

function getConfiguredProfileId({ allowSelectedFallback = true } = {}) {
    const settings = ensureSettings();
    return settings.profileId
        || (allowSelectedFallback ? extension_settings.connectionManager?.selectedProfile : '')
        || '';
}

function refreshSettingsProfileSelect(select = settingsProfileSelect) {
    if (!select) return;

    const settings = ensureSettings();
    const profiles = [...getConnectionProfiles()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const selectedProfileId = settings.profileId;
    select.replaceChildren();

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = 'Connection Manager의 현재 프로필 사용';
    select.append(defaultOption);

    for (const profile of profiles) {
        const option = document.createElement('option');
        option.value = profile.id;
        option.textContent = profile.name || profile.id;
        select.append(option);
    }

    select.value = profiles.some(profile => profile.id === selectedProfileId) ? selectedProfileId : '';
    if (selectedProfileId && !select.value) {
        settings.profileId = '';
        saveSettingsDebounced();
    }
}

function bindSettingsProfileEvents() {
    if (settingsProfileEventsBound) return;
    settingsProfileEventsBound = true;

    for (const eventName of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED']) {
        const eventType = event_types[eventName];
        if (eventType) {
            eventSource.on(eventType, () => refreshSettingsProfileSelect());
        }
    }
}

function createSettingsField(labelText, control) {
    const label = createElement('label', 'wip-settings-field');
    const text = createElement('span', 'wip-settings-label', labelText);
    label.append(text, control);
    return label;
}

function installSettingsPanel() {
    ensureSettings();

    const settingsContainer = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!settingsContainer) {
        setTimeout(installSettingsPanel, 500);
        return;
    }

    if (document.querySelector('#worldinfo_plus_settings')) {
        refreshSettingsProfileSelect();
        return;
    }

    const settings = ensureSettings();
    const panel = createElement('div', 'wip-settings');
    panel.id = 'worldinfo_plus_settings';

    const title = createElement('div', 'wip-settings-title', 'WorldInfo Plus');
    const grid = createElement('div', 'wip-settings-grid');

    const providerSelect = createElement('select', 'text_pole');
    const googleOption = document.createElement('option');
    googleOption.value = 'google';
    googleOption.textContent = 'Google 무료 번역';
    const profileOption = document.createElement('option');
    profileOption.value = 'profile';
    profileOption.textContent = '프로필 번역';
    providerSelect.append(googleOption, profileOption);
    providerSelect.value = settings.translationProvider;

    const languageInput = createElement('input', 'text_pole');
    languageInput.type = 'text';
    languageInput.value = settings.targetLanguage;
    languageInput.placeholder = 'ko';
    languageInput.setAttribute('list', 'worldinfo_plus_language_options');

    const languageList = createElement('datalist');
    languageList.id = 'worldinfo_plus_language_options';
    for (const [code, name] of LANGUAGE_OPTIONS) {
        const option = document.createElement('option');
        option.value = code;
        option.label = name;
        languageList.append(option);
    }

    const profileSelect = createElement('select', 'text_pole');
    settingsProfileSelect = profileSelect;

    providerSelect.addEventListener('change', () => {
        settings.translationProvider = providerSelect.value;
        saveSettingsDebounced();
    });
    languageInput.addEventListener('change', () => {
        settings.targetLanguage = languageInput.value.trim() || DEFAULT_SETTINGS.targetLanguage;
        languageInput.value = settings.targetLanguage;
        saveSettingsDebounced();
    });
    profileSelect.addEventListener('change', () => {
        settings.profileId = profileSelect.value;
        saveSettingsDebounced();
    });

    grid.append(
        createSettingsField('번역 방식', providerSelect),
        createSettingsField('대상 언어', languageInput),
        createSettingsField('연결 프로필', profileSelect),
    );
    panel.append(title, grid, languageList);
    settingsContainer.append(panel);

    refreshSettingsProfileSelect(profileSelect);
    bindSettingsProfileEvents();
}

async function getGoogleTranslateFunction() {
    googleTranslateModulePromise ??= import('/scripts/extensions/translate/index.js');
    const module = await googleTranslateModulePromise;
    if (typeof module.translate !== 'function') {
        throw new Error('Google translation module is not available.');
    }

    return module.translate;
}

async function getConnectionRequestService() {
    const contextService = getContext()?.ConnectionManagerRequestService;
    if (contextService) return contextService;

    connectionRequestServicePromise ??= import('/scripts/extensions/shared.js')
        .then(module => module.ConnectionManagerRequestService);
    const service = await connectionRequestServicePromise;
    if (!service) {
        throw new Error('Connection Manager request service is not available.');
    }

    return service;
}

function extractServiceText(response) {
    if (typeof response === 'string') return response;
    if (typeof response?.content === 'string') return response.content;
    if (typeof response?.text === 'string') return response.text;
    if (typeof response?.message === 'string') return response.message;
    if (typeof response?.choices?.[0]?.message?.content === 'string') return response.choices[0].message.content;
    if (typeof response?.choices?.[0]?.text === 'string') return response.choices[0].text;
    return String(response ?? '');
}

async function sendProfileRequest(prompt, maxTokens, overridePayload = {}) {
    const profileId = getConfiguredProfileId();
    if (!profileId) {
        throw new Error('연결 프로필을 선택하세요.');
    }

    const requestService = await getConnectionRequestService();
    const response = await requestService.sendRequest(profileId, prompt, maxTokens, {
        stream: false,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
    }, overridePayload);

    return extractServiceText(response).trim();
}

async function translateText(text) {
    const settings = ensureSettings();
    const targetLanguage = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;

    if (settings.translationProvider === 'profile') {
        return await sendProfileRequest([
            {
                role: 'system',
                content: 'You are a precise translation engine. Return only the translated text without explanations, notes, markdown fences, or quotes.',
            },
            {
                role: 'user',
                content: `Target language: ${getLanguageLabel(targetLanguage)}\n\nText:\n${text}`,
            },
        ], Math.min(8192, Math.max(512, Math.ceil(text.length * 0.9) + 256)));
    }

    const translate = await getGoogleTranslateFunction();
    const translated = await translate(text, targetLanguage, 'google');
    if (translated === undefined || translated === null) {
        throw new Error('Google 번역에 실패했습니다.');
    }

    return String(translated).trim();
}

function normalizeGeneratedKeyword(value) {
    return String(value ?? '')
        .trim()
        .replace(/^[-*\d.\s]+/, '')
        .replace(/^["'`]+|["'`]+$/g, '')
        .trim();
}

function isRegexKeyword(value) {
    return /^\/(?:\\.|[^/])+\/[dgimsuvy]*$/i.test(String(value ?? '').trim());
}

function uniqueKeywords(keywords) {
    const values = Array.isArray(keywords)
        ? keywords
        : typeof keywords === 'string'
            ? keywords.split(/\r?\n|,/)
            : [];
    const seen = new Set();
    const result = [];

    for (const keyword of values.map(normalizeGeneratedKeyword).filter(Boolean)) {
        const key = keyword.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(keyword);
    }

    return result;
}

function extractJsonPayload(text) {
    const source = String(text ?? '').trim();
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced?.[1]?.trim() || source;

    for (const [startChar, endChar] of [['{', '}'], ['[', ']']]) {
        const start = candidate.indexOf(startChar);
        const end = candidate.lastIndexOf(endChar);
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch {
                // Continue to the next shape.
            }
        }
    }

    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

function parseKeywordListText(text) {
    return uniqueKeywords(String(text ?? '')
        .split(/\r?\n|,/)
        .map(item => item.replace(/^["'\[\]]+|["'\[\]]+$/g, '')));
}

function parseTranslatedKeywordResponse(text, sourceKeywords) {
    const parsed = extractJsonPayload(text);
    let values = parseKeywordListText(text);

    if (Array.isArray(parsed)) {
        values = parsed;
    } else if (Array.isArray(parsed?.translations)) {
        values = parsed.translations;
    } else if (Array.isArray(parsed?.translated)) {
        values = parsed.translated;
    } else if (Array.isArray(parsed?.keywords)) {
        values = parsed.keywords;
    }

    return uniqueKeywords(values)
        .slice(0, sourceKeywords.length)
        .filter((keyword, index) => keyword.toLocaleLowerCase() !== sourceKeywords[index]?.toLocaleLowerCase());
}

async function translateKeywordList(keywords) {
    const sourceKeywords = uniqueKeywords(keywords.filter(keyword => !isRegexKeyword(keyword)));
    if (!sourceKeywords.length) return [];

    const settings = ensureSettings();
    const targetLanguage = settings.targetLanguage || DEFAULT_SETTINGS.targetLanguage;

    if (settings.translationProvider === 'profile') {
        const response = await sendProfileRequest([
            {
                role: 'system',
                content: 'Translate lorebook activation keywords. Return only a JSON array of translated keyword strings, preserving the item order. Do not add explanations.',
            },
            {
                role: 'user',
                content: `Target language: ${getLanguageLabel(targetLanguage)}\nKeywords JSON:\n${JSON.stringify(sourceKeywords)}`,
            },
        ], Math.min(2048, Math.max(256, sourceKeywords.length * 64)));
        return parseTranslatedKeywordResponse(response, sourceKeywords);
    }

    const translated = [];
    for (const keyword of sourceKeywords) {
        const translatedKeyword = normalizeGeneratedKeyword(await translateText(keyword));
        if (translatedKeyword && translatedKeyword.toLocaleLowerCase() !== keyword.toLocaleLowerCase()) {
            translated.push(translatedKeyword);
        }
    }

    return uniqueKeywords(translated);
}

function parseKeywordRecommendation(text) {
    const parsed = extractJsonPayload(text);
    if (Array.isArray(parsed)) {
        return { primary: uniqueKeywords(parsed), secondary: [] };
    }

    if (parsed && typeof parsed === 'object') {
        return {
            primary: uniqueKeywords(parsed.primary || parsed.primary_keywords || parsed.key || parsed.keywords || []),
            secondary: uniqueKeywords(parsed.secondary || parsed.secondary_keywords || parsed.keysecondary || parsed.optional || []),
        };
    }

    return { primary: parseKeywordListText(text), secondary: [] };
}

async function recommendKeywords(entry) {
    const targetLanguage = ensureSettings().targetLanguage || DEFAULT_SETTINGS.targetLanguage;
    const content = entry.querySelector('textarea[name="content"]')?.value?.trim() || '';
    const comment = entry.querySelector('textarea[name="comment"]')?.value?.trim() || '';
    const primary = getKeywordValues(entry, 'key');
    const secondary = getKeywordValues(entry, 'keysecondary');

    if (!content && !comment && !primary.length && !secondary.length) {
        throw new Error('추천에 사용할 본문이나 키워드가 없습니다.');
    }

    const response = await sendProfileRequest([
        {
            role: 'system',
            content: [
                'Recommend concise SillyTavern lorebook activation keywords.',
                'Return strict JSON only: {"primary":["..."],"secondary":["..."]}.',
                'Primary keywords should be aliases, names, places, concepts, and memorable phrases that should activate the entry.',
                'Secondary keywords should only be suggested when they would usefully narrow activation.',
                'Do not include regexes. Do not repeat existing keywords.',
            ].join(' '),
        },
        {
            role: 'user',
            content: [
                `Target keyword language: ${getLanguageLabel(targetLanguage)}`,
                `Existing primary keywords: ${JSON.stringify(primary)}`,
                `Existing secondary keywords: ${JSON.stringify(secondary)}`,
                `Entry title or memo: ${comment || '(none)'}`,
                `Entry content:\n${content.slice(0, 6000)}`,
            ].join('\n\n'),
        },
    ], 1200, {
        temperature: 0.35,
    });

    return parseKeywordRecommendation(response);
}

async function runButtonTask(button, busyText, task) {
    const previousText = button.textContent;
    button.disabled = true;
    button.textContent = busyText;

    try {
        await task();
    } catch (error) {
        console.error('[WorldInfo Plus]', error);
        notify('error', error?.message || String(error));
    } finally {
        button.disabled = false;
        button.textContent = previousText;
    }
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
        const dialog = createElement('div', 'wip-dialog wip-create-dialog');
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
            const movableCheckedCount = entryCheckboxes
                .filter(checkbox => checkbox.checked)
                .filter(checkbox => checkbox.dataset.folderId !== targetSelect.value)
                .length;
            selectAllCheckbox.disabled = !entryCheckboxes.length;
            selectAllCheckbox.checked = !!entryCheckboxes.length && checkedCount === entryCheckboxes.length;
            selectAllCheckbox.indeterminate = checkedCount > 0 && checkedCount < entryCheckboxes.length;
            moveButton.disabled = movableCheckedCount === 0 || !targetSelect.value;
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
            const filterFolderId = filterSelect.value || '__all';
            const entries = Object.values(currentData.entries ?? {})
                .filter(entry => {
                    const currentFolderId = getEntryFolderId(entry);
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
            summary.textContent = `표시 항목 ${entries.length}개`;

            if (!entries.length) {
                list.append(createElement('div', 'wip-dialog-empty', '이 조건에 맞는 항목이 없습니다.'));
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
                checkbox.dataset.folderId = getEntryFolderId(entry);
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

        targetSelect.addEventListener('change', updateSelectAllState);
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
        dialog.append(title, filterRow, searchInput, selectAllRow, list, targetRow, footer);
        overlay.append(dialog);
        (document.querySelector('#WorldInfo') || document.body).append(overlay);

        fillTargetOptions();
        fillFilterOptions();
        renderEntryList();
        filterSelect.focus();
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
        'fa-folder-tree',
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
    const getStoredFolderId = uid => {
        const folderId = store.entryFolders[uid];
        return folderId && validFolderIds.has(folderId) ? folderId : UNFILED_ID;
    };
    const movableUids = normalizedUids.filter(uid => getStoredFolderId(uid) !== normalizedTargetFolderId);
    if (!movableUids.length) return;

    const movingUidSet = new Set(movableUids);

    for (const folderId of Object.keys(store.entryOrder)) {
        store.entryOrder[folderId] = store.entryOrder[folderId]
            .filter(entryUid => !movingUidSet.has(String(entryUid)));
    }

    if (normalizedTargetFolderId === UNFILED_ID) {
        for (const uid of movableUids) {
            delete store.entryFolders[uid];
        }
        store.entryOrder[UNFILED_ID].push(...movableUids);
    } else {
        store.entryOrder[normalizedTargetFolderId] = Array.isArray(store.entryOrder[normalizedTargetFolderId])
            ? store.entryOrder[normalizedTargetFolderId]
            : [];

        for (const uid of movableUids) {
            store.entryFolders[uid] = normalizedTargetFolderId;
        }

        store.entryOrder[normalizedTargetFolderId].push(...movableUids);
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

function appendNodeIfPresent(target, node) {
    if (!target || !node) return false;
    target.append(node);
    return true;
}

function isVisibleElement(element) {
    return !!element && !element.hidden && getComputedStyle(element).display !== 'none';
}

function getKeywordControl(entry, fieldName) {
    const select = entry.querySelector(`select[name="${fieldName}"]`);
    const textarea = entry.querySelector(`textarea[name="${fieldName}"]`);
    const select2Container = select?.nextElementSibling?.classList.contains('select2-container')
        ? select.nextElementSibling
        : null;

    if (select && isVisibleElement(select2Container)) {
        return { type: 'select', element: select };
    }

    if (textarea && isVisibleElement(textarea)) {
        return { type: 'textarea', element: textarea };
    }

    if (select) return { type: 'select', element: select };
    if (textarea) return { type: 'textarea', element: textarea };
    return null;
}

function getKeywordValues(entry, fieldName) {
    const control = getKeywordControl(entry, fieldName);
    if (!control) return [];

    if (control.type === 'textarea') {
        return uniqueKeywords(splitKeywordsAndRegexes(control.element.value || ''));
    }

    const select = control.element;
    const $select = globalThis.jQuery?.(select);
    try {
        if ($select?.data('select2')) {
            return uniqueKeywords($select.select2('data').map(item => item.text));
        }
    } catch (error) {
        console.warn('[WorldInfo Plus] Could not read Select2 keyword data', error);
    }

    return uniqueKeywords(Array.from(select.selectedOptions).map(option => option.textContent || option.value));
}

function dispatchNativeInputChange(element) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
}

function setKeywordValues(entry, fieldName, values) {
    const control = getKeywordControl(entry, fieldName);
    if (!control) return false;

    const keywords = uniqueKeywords(values);
    if (control.type === 'textarea') {
        control.element.value = keywords.join(', ');
        dispatchNativeInputChange(control.element);
        return true;
    }

    const select = control.element;
    const optionValues = [];
    for (const keyword of keywords) {
        const optionId = getSelect2OptionId(keyword);
        let option = Array.from(select.options).find(item => item.value === optionId || item.textContent === keyword);
        if (!option) {
            option = new Option(keyword, optionId, true, true);
            select.append(option);
        }

        optionValues.push(option.value);
    }

    for (const option of select.options) {
        option.selected = optionValues.includes(option.value);
    }

    const $select = globalThis.jQuery?.(select);
    if ($select?.length) {
        $select.val(optionValues).trigger('change');
    } else {
        dispatchNativeInputChange(select);
    }

    return true;
}

function appendKeywordsToEntry(entry, fieldName, keywords) {
    const existing = getKeywordValues(entry, fieldName);
    const merged = uniqueKeywords([...existing, ...keywords]);
    const addedCount = merged.length - existing.length;

    if (addedCount <= 0) return 0;
    setKeywordValues(entry, fieldName, merged);
    return addedCount;
}

function ensureContentTranslationTools(panel, contentBlock) {
    if (!panel || !contentBlock || panel.querySelector(':scope > .wip-content-translation-actions')) return;

    const textarea = contentBlock.querySelector('textarea[name="content"]');
    if (!textarea) return;

    const actions = createElement('div', 'wip-content-translation-actions');
    const translateButton = createElement('button', 'menu_button wip-translate-content-button', '번역');
    translateButton.type = 'button';
    actions.append(translateButton);

    const grid = createElement('div', 'wip-content-translation-grid');
    const originalPane = createElement('div', 'wip-content-translation-pane wip-content-original-pane');
    const resultPane = createElement('div', 'wip-content-translation-pane wip-content-result-pane');
    const resultLabel = createElement('small', 'wip-content-translation-label', '번역문');
    const resultTextarea = createElement('textarea', 'text_pole textarea_compact wip-content-translation-output');
    resultTextarea.readOnly = true;
    resultTextarea.placeholder = '번역 결과';
    resultPane.hidden = true;
    resultPane.append(resultLabel, resultTextarea);

    contentBlock.replaceWith(grid);
    originalPane.append(contentBlock);
    grid.append(originalPane, resultPane);
    panel.insertBefore(actions, grid);

    translateButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        runButtonTask(translateButton, '번역 중...', async () => {
            const text = textarea.value || '';
            if (!text.trim()) {
                notify('warning', '본문이 비어 있습니다.');
                return;
            }

            const translated = await translateText(text);
            resultTextarea.value = translated;
            resultPane.hidden = false;
            grid.classList.add('wip-content-translation-active');
        });
    });
}

function ensureKeywordTranslationTools(entry, panel, keywordsBlock) {
    if (!entry || !panel || !keywordsBlock || panel.querySelector(':scope > .wip-keyword-tools')) return;

    const tools = createElement('div', 'wip-keyword-tools');
    const translateButton = createElement('button', 'menu_button wip-keyword-tool-button', '키워드 번역');
    const recommendButton = createElement('button', 'menu_button wip-keyword-tool-button', 'AI 키워드 추천');
    translateButton.type = 'button';
    recommendButton.type = 'button';
    tools.append(translateButton, recommendButton);
    keywordsBlock.insertAdjacentElement('afterend', tools);

    translateButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        runButtonTask(translateButton, '번역 중...', async () => {
            const primary = getKeywordValues(entry, 'key');
            const secondary = getKeywordValues(entry, 'keysecondary');
            const translatedPrimary = await translateKeywordList(primary);
            const translatedSecondary = await translateKeywordList(secondary);
            const addedPrimary = appendKeywordsToEntry(entry, 'key', translatedPrimary);
            const addedSecondary = appendKeywordsToEntry(entry, 'keysecondary', translatedSecondary);
            const addedTotal = addedPrimary + addedSecondary;

            notify(addedTotal ? 'success' : 'warning', addedTotal
                ? `번역 키워드 ${addedTotal}개를 추가했습니다.`
                : '추가할 번역 키워드가 없습니다.');
        });
    });

    recommendButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        runButtonTask(recommendButton, '추천 중...', async () => {
            const recommendations = await recommendKeywords(entry);
            const addedPrimary = appendKeywordsToEntry(entry, 'key', recommendations.primary);
            const addedSecondary = appendKeywordsToEntry(entry, 'keysecondary', recommendations.secondary);
            const addedTotal = addedPrimary + addedSecondary;

            notify(addedTotal ? 'success' : 'warning', addedTotal
                ? `추천 키워드 ${addedTotal}개를 추가했습니다.`
                : '추가할 추천 키워드가 없습니다.');
        });
    });
}

function getEntryPanel(edit, tabId) {
    return edit?.querySelector(`:scope > .wip-entry-tabs .wip-entry-tabpanel[data-tab-id="${tabId}"]`) || null;
}

function ensureEntryEnhancements(entry, edit) {
    const contentPanel = getEntryPanel(edit, 'content');
    const activationPanel = getEntryPanel(edit, 'activation');
    const contentBlock = contentPanel?.querySelector('[name="contentAndCharFilterBlock"]')
        || edit?.querySelector('[name="contentAndCharFilterBlock"]');
    const keywordsBlock = activationPanel?.querySelector('[name="keywordsAndLogicBlock"]')
        || edit?.querySelector('[name="keywordsAndLogicBlock"]');

    ensureContentTranslationTools(contentPanel, contentBlock);
    ensureKeywordTranslationTools(entry, activationPanel, keywordsBlock);
}

function getEntryHeaderControls(entry) {
    return entry.querySelector(':scope .world_entry_form > .inline-drawer > .inline-drawer-header .WIEnteryHeaderControls')
        || entry.querySelector(':scope .WIEnteryHeaderControls');
}

function getEntryHeader(entry) {
    return entry.querySelector(':scope .world_entry_form > .inline-drawer > .inline-drawer-header')
        || entry.querySelector(':scope .inline-drawer-header');
}

function restoreEntryInsertionControls(entry) {
    const header = getEntryHeader(entry);
    const headerControls = getEntryHeaderControls(entry);
    if (!header || !headerControls || header.contains(headerControls)) return;
    header.append(headerControls);
}

function moveEntryInsertionControlsToTab(entry, edit) {
    const activationPanel = edit?.querySelector(':scope > .wip-entry-tabs .wip-entry-tabpanel[data-tab-id="activation"]');
    const headerControls = getEntryHeaderControls(entry);
    if (!activationPanel) return;
    if (headerControls && !activationPanel.contains(headerControls)) {
        activationPanel.prepend(headerControls);
    }
}

function getFieldWideRow(rootElement, fieldName) {
    const field = rootElement?.querySelector(`[name="${fieldName}"]`);
    return field?.closest('.flex-container.wide100p.flexGap10') || null;
}

function getFieldContainer(rootElement, fieldName) {
    const field = rootElement?.querySelector(`[name="${fieldName}"]`);
    return field?.closest('.world_entry_form_control, .flex4, .flex2, .flex1') || null;
}

function removeIfEmpty(element) {
    if (element && element.children.length === 0) {
        element.remove();
    }
}

function getRecursionOptions(contentBlock) {
    const recursionField = contentBlock?.querySelector('[name="excludeRecursion"]');
    const column = recursionField?.closest('.flex-container.flexFlowColumn');
    const group = column?.parentElement;

    if (!group || !group.querySelector('[name="preventRecursion"], [name="delay_until_recursion"], [name="ignoreBudget"]')) {
        return null;
    }

    group.classList.add('wip-entry-recursion-options');
    return group;
}

function markEntryFilterLayout(filtersRow) {
    if (!filtersRow) return null;

    const characterFilter = getFieldContainer(filtersRow, 'characterFilter');
    const triggerFilter = getFieldContainer(filtersRow, 'triggers');
    const characterHeader = characterFilter?.querySelector(':scope > .flex-container.justifySpaceBetween');
    const triggerHeader = triggerFilter?.querySelector(':scope > .flex-container.justifySpaceBetween');
    const characterExclusion = characterHeader?.querySelector('[name="character_exclusion"]')?.closest('label');

    filtersRow.classList.add('wip-entry-filter-grid');
    characterFilter?.classList.add('wip-entry-filter-character');
    triggerFilter?.classList.add('wip-entry-filter-trigger');
    characterHeader?.classList.add('wip-entry-filter-character-header');
    triggerHeader?.classList.add('wip-entry-filter-trigger-header');
    characterHeader?.querySelector('small[for="characterFilter"]')?.classList.add('wip-entry-filter-character-label');
    triggerHeader?.querySelector('small')?.classList.add('wip-entry-filter-trigger-label');
    characterExclusion?.classList.add('wip-entry-filter-exclude');
    triggerHeader?.querySelector('label[for="__invisible"]')?.classList.add('wip-entry-filter-trigger-spacer');
    characterFilter?.querySelector(':scope > .range-block-range')?.classList.add('wip-entry-filter-character-input');
    triggerFilter?.querySelector(':scope > .range-block-range')?.classList.add('wip-entry-filter-trigger-input');

    return filtersRow;
}

function createEntryAdvancedRow(className, nodes) {
    const row = createElement('div', `wip-entry-advanced-row ${className}`);

    for (const node of nodes) {
        appendNodeIfPresent(row, node);
    }

    return row.children.length > 0 ? row : null;
}

function getEntryAdvancedRows(edit, recursionOptions) {
    const originalTimingRow = getFieldWideRow(edit, 'group');
    const groupRow = createEntryAdvancedRow('wip-entry-advanced-group-row', [
        getFieldContainer(edit, 'group'),
        getFieldContainer(edit, 'groupWeight'),
        getFieldContainer(edit, 'useGroupScoring'),
        getFieldContainer(edit, 'automationId'),
    ]);
    const timingRow = createEntryAdvancedRow('wip-entry-advanced-timing-row', [
        getFieldContainer(edit, 'sticky'),
        getFieldContainer(edit, 'cooldown'),
        getFieldContainer(edit, 'delay'),
    ]);
    const recursionRow = createEntryAdvancedRow('wip-entry-advanced-recursion-row', [
        recursionOptions,
        getFieldContainer(edit, 'delayUntilRecursionLevel'),
    ]);

    removeIfEmpty(originalTimingRow);

    return { groupRow, timingRow, recursionRow };
}

function createEntryTabLayout(entry, edit) {
    const uid = getEntryUid(entry) || 'new';
    const baseId = `wip-entry-${uid}-${++entryTabIdCounter}`;
    const tabsRoot = createElement('div', 'wip-entry-tabs');
    const tabList = createElement('div', 'wip-entry-tablist');
    const panelsRoot = createElement('div', 'wip-entry-tabpanels');
    const panels = {};

    tabList.setAttribute('role', 'tablist');
    tabList.setAttribute('aria-label', '로어북 엔트리 편집');

    for (const tab of ENTRY_TABS) {
        const tabId = `${baseId}-${tab.id}-tab`;
        const panelId = `${baseId}-${tab.id}-panel`;
        const button = createElement('button', 'wip-entry-tab', tab.label);
        const panel = createElement('section', 'wip-entry-tabpanel');

        button.type = 'button';
        button.id = tabId;
        button.dataset.tabId = tab.id;
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', panelId);
        button.setAttribute('aria-selected', 'false');
        button.tabIndex = -1;
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            setEntryActiveTab(edit, tab.id);
        });
        button.addEventListener('keydown', handleEntryTabKeydown);

        panel.id = panelId;
        panel.dataset.tabId = tab.id;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tabId);
        panel.hidden = true;

        tabList.append(button);
        panelsRoot.append(panel);
        panels[tab.id] = panel;
    }

    tabsRoot.append(tabList, panelsRoot);
    edit.prepend(tabsRoot);
    return panels;
}

function setEntryActiveTab(edit, activeTabId) {
    const tabs = Array.from(edit.querySelectorAll(':scope > .wip-entry-tabs .wip-entry-tab'));
    const panels = Array.from(edit.querySelectorAll(':scope > .wip-entry-tabs .wip-entry-tabpanel'));

    for (const tab of tabs) {
        const isActive = tab.dataset.tabId === activeTabId;
        tab.setAttribute('aria-selected', String(isActive));
        tab.tabIndex = isActive ? 0 : -1;
    }

    for (const panel of panels) {
        panel.hidden = panel.dataset.tabId !== activeTabId;
    }
}

function handleEntryTabKeydown(event) {
    const handledKeys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!handledKeys.includes(event.key)) return;

    const tabList = event.currentTarget.closest('.wip-entry-tablist');
    const tabs = Array.from(tabList?.querySelectorAll('.wip-entry-tab') ?? []);
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex === -1) return;

    event.preventDefault();
    event.stopPropagation();

    let nextIndex = currentIndex;
    if (event.key === 'ArrowLeft') {
        nextIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
    } else if (event.key === 'ArrowRight') {
        nextIndex = currentIndex === tabs.length - 1 ? 0 : currentIndex + 1;
    } else if (event.key === 'Home') {
        nextIndex = 0;
    } else if (event.key === 'End') {
        nextIndex = tabs.length - 1;
    }

    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
}

function arrangeEntryTabContent(entry, edit, panels) {
    const contentBlock = edit.querySelector('[name="contentAndCharFilterBlock"]');
    const commentContainer = edit.querySelector('.commentContainer');
    const recursionOptions = getRecursionOptions(contentBlock);
    const keywordsBlock = edit.querySelector('[name="keywordsAndLogicBlock"]');
    const perEntryOverridesBlock = edit.querySelector('[name="perEntryOverridesBlock"]');
    const bottomControls = edit.querySelector('[name="WIEntryBottomControls"]');
    const advancedRows = getEntryAdvancedRows(edit, recursionOptions);
    const filtersRow = markEntryFilterLayout(getFieldWideRow(edit, 'characterFilter'));
    const additionalMatchingSources = edit.querySelector(':scope > .inline-drawer');

    appendNodeIfPresent(panels.content, contentBlock);
    ensureContentTranslationTools(panels.content, contentBlock);
    appendNodeIfPresent(panels.content, commentContainer);

    appendNodeIfPresent(panels.activation, getEntryHeaderControls(entry));
    appendNodeIfPresent(panels.activation, keywordsBlock);
    ensureKeywordTranslationTools(entry, panels.activation, keywordsBlock);
    appendNodeIfPresent(panels.activation, perEntryOverridesBlock);
    appendNodeIfPresent(panels.activation, bottomControls);

    appendNodeIfPresent(panels.filters, filtersRow);
    appendNodeIfPresent(panels.filters, additionalMatchingSources);

    appendNodeIfPresent(panels.advanced, advancedRows.groupRow);
    appendNodeIfPresent(panels.advanced, advancedRows.timingRow);
    appendNodeIfPresent(panels.advanced, advancedRows.recursionRow);
}

function ensureEntryTabs(entry) {
    const edit = entry.querySelector(':scope .world_entry_edit');
    if (!edit) return false;

    if (edit.dataset.wipTabs === 'true') {
        moveEntryInsertionControlsToTab(entry, edit);
        ensureEntryEnhancements(entry, edit);
        return true;
    }

    const panels = createEntryTabLayout(entry, edit);
    arrangeEntryTabContent(entry, edit, panels);
    edit.dataset.wipTabs = 'true';
    moveEntryInsertionControlsToTab(entry, edit);
    ensureEntryEnhancements(entry, edit);
    setEntryActiveTab(edit, 'content');
    return true;
}

function scheduleEnsureEntryTabs(entry, attempts = 6) {
    setTimeout(() => {
        if (ensureEntryTabs(entry)) return;
        if (attempts > 1) {
            scheduleEnsureEntryTabs(entry, attempts - 1);
        }
    }, 50);
}

function bindEntryTabOpenHandler(entry) {
    if (entryTabOpenHandlers.has(entry)) return;

    const toggle = entry.querySelector(':scope .world_entry_form > .inline-drawer > .inline-drawer-header .inline-drawer-toggle');
    if (!toggle) return;

    entryTabOpenHandlers.add(entry);
    toggle.addEventListener('click', () => {
        restoreEntryInsertionControls(entry);
    }, { capture: true });
    toggle.addEventListener('click', () => {
        scheduleEnsureEntryTabs(entry);
        setTimeout(() => {
            const edit = entry.querySelector(':scope .world_entry_edit[data-wip-tabs="true"]');
            if (edit) {
                setEntryActiveTab(edit, 'content');
            }
        }, 80);
    });
}

function nodeContainsEntryEdit(node) {
    return node.nodeType === Node.ELEMENT_NODE
        && (node.matches?.('.world_entry_edit') || node.querySelector?.('.world_entry_edit'));
}

function ensureEntryTabsInList(entriesList) {
    for (const entry of collectRenderedEntries(entriesList)) {
        bindEntryTabOpenHandler(entry);
        ensureEntryTabs(entry);
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
        bindEntryTabOpenHandler(entry);
        ensureEntryTabs(entry);
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
    entriesObserver = new MutationObserver(mutations => {
        if (isOrganizing) return;
        if (!isCurrentBookSelected()) {
            scheduleLoadSelectedBook();
            return;
        }

        const hasEntryListChange = mutations.some(mutation => mutation.target === entriesList);
        const hasEntryEditChange = mutations.some(mutation => Array.from(mutation.addedNodes).some(nodeContainsEntryEdit));

        if (hasEntryEditChange) {
            ensureEntryTabsInList(entriesList);
        }

        if (hasEntryListChange) {
            scheduleRenderData();
        }
    });
    entriesObserver.observe(entriesList, { childList: true, subtree: true });
}

function mount() {
    installSettingsPanel();

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

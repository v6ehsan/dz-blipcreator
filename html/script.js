let state = {
    blips: [],
    markers: [],
    checkpoints: [],
    colors: [],
    defaults: null,
    playerCoords: { x: 0, y: 0, z: 0 },
    selectedBlip: null,
    selectedMarker: null,
    selectedCheckpoint: null,
    activeItems: {}, // uid -> {type, label, data}

    // Position offset (meters, world X/Y/Z) applied on top of a base coord
    // for each tab - lets you nudge the live preview without walking.
    blipOffset: { x: 0, y: 0, z: 0 },
    markerOffset: { x: 0, y: 0, z: 0 },
    checkpointOffset: { x: 0, y: 0, z: 0 },

    // When null, that tab's base position is "wherever I'm currently
    // standing" (state.playerCoords). Editing an existing item sets this to
    // that item's original coords instead, so the offset nudges from there.
    blipBase: null,
    markerBase: null,
    checkpointBase: null,

    // { kind: 'blip'|'marker'|'checkpoint', uid } while editing an existing
    // active item, otherwise null.
    editing: null
};

const app = document.getElementById('app');

function resourceName() {
    return window.GetParentResourceName ? GetParentResourceName() : 'dz-blipcreator';
}

// Base + offset = the coords actually used for the preview/spawn of a given
// tab. Base is the item's original position while editing, or the player's
// current position otherwise.
function computeCoords(kind) {
    const base = state[kind + 'Base'] || state.playerCoords;
    const off = state[kind + 'Offset'];
    return { x: base.x + off.x, y: base.y + off.y, z: base.z + off.z };
}

// Waits for a short pause in calls before actually firing - used so
// dragging a slider doesn't spam the client with a preview update on every
// single pixel of movement (checkpoints in particular have to be deleted
// and recreated in-game, so this keeps that cheap).
function debounce(fn, wait) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), wait);
    };
}

// Two-way binds a <input type="range"> and a <input type="number"> so
// either one can drive the value - dragging the slider updates the number,
// typing an exact number (even outside the slider's min/max) updates the
// preview immediately. This is what makes every field "full custom"
// instead of being capped to whatever range the slider allows.
function pairSliderNumber(sliderId, numberId, onChange) {
    const slider = document.getElementById(sliderId);
    const number = document.getElementById(numberId);
    if (!slider || !number) return;
    slider.addEventListener('input', () => {
        number.value = slider.value;
        onChange();
    });
    number.addEventListener('input', () => {
        const v = parseFloat(number.value);
        if (!isNaN(v)) {
            const min = parseFloat(slider.min), max = parseFloat(slider.max);
            slider.value = Math.min(Math.max(v, min), max);
        }
        onChange();
    });
}

function setLiveBadge(id, active) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', active);
}

// Sets every scale/color/radius field to the values from Config.Defaults
// (falling back to whatever's already in the HTML if the server didn't
// send any), so a server owner can change the starting point for the whole
// menu from config.lua without touching any front-end code.
function applyDefaults() {
    const def = state.defaults || {};

    const blipScale = def.blipScale ?? parseFloat(document.getElementById('blipScale').value);
    document.getElementById('blipScale').value = blipScale;
    document.getElementById('blipScaleNum').value = blipScale;
    document.getElementById('blipScaleVal').textContent = parseFloat(blipScale).toFixed(1);

    const mc = def.markerColor || {};
    const ms = def.markerScale || {};
    setSliderNum('markerR', 'markerRNum', mc.r ?? 255);
    setSliderNum('markerG', 'markerGNum', mc.g ?? 0);
    setSliderNum('markerB', 'markerBNum', mc.b ?? 255);
    setSliderNum('markerA', 'markerANum', mc.a ?? 150);
    document.getElementById('markerScaleX').value = ms.x ?? 1.0;
    document.getElementById('markerScaleY').value = ms.y ?? 1.0;
    document.getElementById('markerScaleZ').value = ms.z ?? 1.0;
    setSliderNum('markerScale', 'markerScaleNum', ms.x ?? 1.0);
    document.getElementById('markerScaleVal').textContent = parseFloat(ms.x ?? 1.0).toFixed(1);

    const cc = def.checkpointColor || {};
    setSliderNum('checkpointR', 'checkpointRNum', cc.r ?? 255);
    setSliderNum('checkpointG', 'checkpointGNum', cc.g ?? 0);
    setSliderNum('checkpointB', 'checkpointBNum', cc.b ?? 255);
    setSliderNum('checkpointA', 'checkpointANum', cc.a ?? 150);
    const radius = def.checkpointRadius ?? 5.0;
    document.getElementById('checkpointRadius').value = radius;
    document.getElementById('checkpointRadiusNum').value = radius;
    document.getElementById('checkpointRadiusVal').textContent = parseFloat(radius).toFixed(1);

    setSliderNum('blipHeading', 'blipHeadingNum', 0);
    document.getElementById('blipHeadingVal').textContent = '0°';
    setSliderNum('markerHeading', 'markerHeadingNum', 0);
    document.getElementById('markerHeadingVal').textContent = '0°';
    setSliderNum('checkpointHeading', 'checkpointHeadingNum', 0);
    document.getElementById('checkpointHeadingVal').textContent = '0°';
}

function setSliderNum(sliderId, numberId, value) {
    document.getElementById(sliderId).value = value;
    document.getElementById(numberId).value = value;
}

// ============ POSITION OFFSET ============
// Wires the X/Y/Z number inputs for one tab to state.<kind>Offset, and its
// "My position" button to snap back to a fresh live player position.
function wireOffset(kind, onChange) {
    ['X', 'Y', 'Z'].forEach(axis => {
        const input = document.getElementById(kind + 'Off' + axis);
        input.addEventListener('input', () => {
            const v = parseFloat(input.value);
            state[kind + 'Offset'][axis.toLowerCase()] = isNaN(v) ? 0 : v;
            onChange();
        });
    });
    document.getElementById(kind + 'ResetOffsetBtn').addEventListener('click', async () => {
        state[kind + 'Offset'] = { x: 0, y: 0, z: 0 };
        state[kind + 'Base'] = null;
        setOffsetInputs(kind);
        const coords = await nuiFetch('getPlayerCoords');
        if (coords) state.playerCoords = coords;
        onChange();
    });
}

function setOffsetInputs(kind) {
    const off = state[kind + 'Offset'];
    document.getElementById(kind + 'OffX').value = off.x;
    document.getElementById(kind + 'OffY').value = off.y;
    document.getElementById(kind + 'OffZ').value = off.z;
}

// Arrow keys nudge X/Y, Q/E nudge Z, Shift = bigger step. Only active while
// the menu is open, a blips/markers/checkpoints tab is selected, and focus
// isn't inside a text/number field (so typing still works normally).
const OFFSET_STEP = 0.5, OFFSET_STEP_BIG = 2.0, Z_STEP = 0.25, Z_STEP_BIG = 1.0;
document.addEventListener('keydown', (e) => {
    if (app.classList.contains('hidden')) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

    const activeTabBtn = document.querySelector('.tab-btn.active');
    const tab = activeTabBtn ? activeTabBtn.dataset.tab : null;
    const kind = tab === 'blips' ? 'blip' : tab === 'markers' ? 'marker' : tab === 'checkpoints' ? 'checkpoint' : null;
    if (!kind) return;

    const big = e.shiftKey;
    let dx = 0, dy = 0, dz = 0;
    if (e.key === 'ArrowLeft') dx = -(big ? OFFSET_STEP_BIG : OFFSET_STEP);
    else if (e.key === 'ArrowRight') dx = (big ? OFFSET_STEP_BIG : OFFSET_STEP);
    else if (e.key === 'ArrowUp') dy = (big ? OFFSET_STEP_BIG : OFFSET_STEP);
    else if (e.key === 'ArrowDown') dy = -(big ? OFFSET_STEP_BIG : OFFSET_STEP);
    else if (e.key === 'q' || e.key === 'Q') dz = -(big ? Z_STEP_BIG : Z_STEP);
    else if (e.key === 'e' || e.key === 'E') dz = (big ? Z_STEP_BIG : Z_STEP);
    else return;

    e.preventDefault();
    const off = state[kind + 'Offset'];
    off.x += dx; off.y += dy; off.z += dz;
    setOffsetInputs(kind);
    if (kind === 'blip') { updateBlipCodePreview(); sendBlipPreview(); }
    else if (kind === 'marker') { updateMarkerCodePreview(); sendMarkerPreview(); }
    else { updateCheckpointCodePreview(); sendCheckpointPreview(); }
});

// ============ HEADING ============
function wireHeading(kind, onChange) {
    pairSliderNumber(kind + 'Heading', kind + 'HeadingNum', () => {
        document.getElementById(kind + 'HeadingVal').textContent =
            Math.round(parseFloat(document.getElementById(kind + 'HeadingNum').value || 0)) + '°';
        onChange();
    });
}

// ============ EDIT MODE ============
// Finds the config-list entry matching a saved item's type id, falling back
// to a synthetic entry (built from the saved label) if the config changed
// since it was placed.
function findById(list, id) {
    for (const group of list) {
        const found = (group.list || []).find(x => String(x.id) === String(id));
        if (found) return found;
    }
    return null;
}

function setEditUI(kind, isEditing) {
    document.getElementById(kind + 'EditBanner').classList.toggle('hidden', !isEditing);
    const btn = document.getElementById(kind === 'checkpoint' ? 'spawnCheckpointBtn' : kind === 'marker' ? 'spawnMarkerBtn' : 'spawnBlipBtn');
    btn.textContent = isEditing ? '💾 Save Changes' : '➕ Add to Map';
}

function startEdit(uid) {
    const item = state.activeItems[uid];
    if (!item) return;
    const kind = item.type; // 'blip' | 'marker' | 'checkpoint'
    const d = item.data;

    // Switch to the matching tab.
    document.querySelector(`.tab-btn[data-tab="${kind}s"]`).click();

    state.editing = { kind, uid };
    state[kind + 'Base'] = { ...d.coords };
    state[kind + 'Offset'] = { x: 0, y: 0, z: 0 };
    setOffsetInputs(kind);

    if (kind === 'blip') {
        const b = findById(state.blips, d.sprite) || { id: d.sprite, name: d.typeName || 'Blip' };
        applyBlipSelection(b);
        document.getElementById('blipColorSelect').value = d.color;
        setSliderNum('blipScale', 'blipScaleNum', d.scale ?? 1.0);
        document.getElementById('blipScaleVal').textContent = parseFloat(d.scale ?? 1.0).toFixed(1);
        document.getElementById('blipLabel').value = d.label || '';
        setSliderNum('blipHeading', 'blipHeadingNum', d.heading ?? 0);
        document.getElementById('blipHeadingVal').textContent = Math.round(d.heading ?? 0) + '°';
        updateBlipCodePreview();
        sendBlipPreview();
    } else if (kind === 'marker') {
        const m = findById(state.markers, d.markerType) || { id: d.markerType, name: d.typeName || 'Marker' };
        applyMarkerSelection(m);
        setSliderNum('markerR', 'markerRNum', d.r ?? 255);
        setSliderNum('markerG', 'markerGNum', d.g ?? 0);
        setSliderNum('markerB', 'markerBNum', d.b ?? 255);
        setSliderNum('markerA', 'markerANum', d.a ?? 150);
        document.getElementById('markerScaleX').value = d.scaleX ?? 1.0;
        document.getElementById('markerScaleY').value = d.scaleY ?? 1.0;
        document.getElementById('markerScaleZ').value = d.scaleZ ?? 1.0;
        setSliderNum('markerScale', 'markerScaleNum', d.scaleX ?? 1.0);
        document.getElementById('markerScaleVal').textContent = parseFloat(d.scaleX ?? 1.0).toFixed(1);
        setSliderNum('markerHeading', 'markerHeadingNum', d.heading ?? 0);
        document.getElementById('markerHeadingVal').textContent = Math.round(d.heading ?? 0) + '°';
        updateMarkerColorPreview();
        updateMarkerCodePreview();
        sendMarkerPreview();
    } else {
        const c = findById(state.checkpoints, d.checkpointType) || { id: d.checkpointType, name: d.typeName || 'Checkpoint' };
        applyCheckpointSelection(c);
        setSliderNum('checkpointR', 'checkpointRNum', d.r ?? 255);
        setSliderNum('checkpointG', 'checkpointGNum', d.g ?? 0);
        setSliderNum('checkpointB', 'checkpointBNum', d.b ?? 255);
        setSliderNum('checkpointA', 'checkpointANum', d.a ?? 150);
        setSliderNum('checkpointRadius', 'checkpointRadiusNum', d.radius ?? 5.0);
        document.getElementById('checkpointRadiusVal').textContent = parseFloat(d.radius ?? 5.0).toFixed(1);
        setSliderNum('checkpointHeading', 'checkpointHeadingNum', d.heading ?? 0);
        document.getElementById('checkpointHeadingVal').textContent = Math.round(d.heading ?? 0) + '°';
        updateCheckpointColorPreview();
        updateCheckpointCodePreview();
        sendCheckpointPreview();
    }

    setEditUI(kind, true);
}

function cancelEdit(kind) {
    if (!kind) return;
    state.editing = null;
    state[kind + 'Base'] = null;
    state[kind + 'Offset'] = { x: 0, y: 0, z: 0 };
    setOffsetInputs(kind);
    setEditUI(kind, false);
    nuiFetch('clearPreview', { kind });
    setLiveBadge(kind + 'LiveBadge', false);
}

async function nuiFetch(endpoint, data = {}) {
    try {
        const resp = await fetch(`https://${resourceName()}/${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(data)
        });
        return await resp.json();
    } catch (e) {
        return null;
    }
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
}

// ============ NUI MESSAGE LISTENER ============
window.addEventListener('message', (e) => {
    const d = e.data;
    if (d.action === 'open') {
        state.blips = d.blips;
        state.markers = d.markers;
        state.checkpoints = d.checkpoints || [];
        state.colors = d.colors;
        state.defaults = d.defaults || null;
        state.playerCoords = d.playerCoords;
        app.classList.remove('hidden');
        renderBlipColors();
        renderBlipList();
        renderMarkerList();
        renderCheckpointList();
        applyDefaults();
        updateMarkerColorPreview();
        updateCheckpointColorPreview();
    } else if (d.action === 'close') {
        app.classList.add('hidden');
        nuiFetch('clearPreview');
    } else if (d.action === 'syncActive') {
        // Authoritative list from the server: rebuilds Active Items so it
        // always reflects everything saved (by any admin), not just what
        // this client happened to create this session.
        state.activeItems = {};
        (d.points || []).forEach(p => {
            const label = (p.data && (p.data.label || p.data.typeName)) || p.kind;
            state.activeItems[p.uid] = { type: p.kind, label, data: p.data };
        });
        renderActiveList();
    }
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        nuiFetch('closeMenu');
        app.classList.add('hidden');
    }
});

document.getElementById('closeBtn').addEventListener('click', () => {
    nuiFetch('closeMenu');
    app.classList.add('hidden');
});

// ============ TABS ============
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');

        // Only one tab's item should ever be visible in-game at a time.
        nuiFetch('clearPreview');
        ['blipLiveBadge', 'markerLiveBadge', 'checkpointLiveBadge'].forEach(id => setLiveBadge(id, false));

        if (btn.dataset.tab === 'active') {
            renderActiveList();
        } else if (btn.dataset.tab === 'blips' && state.selectedBlip) {
            sendBlipPreview();
        } else if (btn.dataset.tab === 'markers' && state.selectedMarker) {
            sendMarkerPreview();
        } else if (btn.dataset.tab === 'checkpoints' && state.selectedCheckpoint) {
            sendCheckpointPreview();
        }
    });
});

// ============ BLIP COLOR SELECT ============
function renderBlipColors() {
    const sel = document.getElementById('blipColorSelect');
    sel.innerHTML = '';
    state.colors.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (${c.id})`;
        sel.appendChild(opt);
    });
}

// ============ ICON HELPERS ============
// Builds a small colored "monogram" badge (initials) as a guaranteed-visible
// fallback whenever a remote icon image fails to load or times out.
function monogramBadge(name, id, extraClass = '') {
    const span = document.createElement('span');
    span.className = `item-id-badge ${extraClass}`.trim();
    const initials = (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
    span.textContent = initials || String(id);
    span.title = `${name} (ID: ${id})`;
    return span;
}

// Creates an <img> that lazy-loads (so we don't fire hundreds of requests to
// the same host at once, which the CEF browser will throttle/queue and can
// look like icons "never show up"), skips sending a referrer (some icon CDNs
// reject hotlink requests coming from an unfamiliar/game referrer), tries
// each URL in `urls` in order (some hosts like raw.githubusercontent.com
// rate-limit or block hotlinking from non-browser clients), and finally
// swaps itself for a monogram badge if every source fails.
function buildThumb(urls, name, id, className = 'item-thumb') {
    const sources = Array.isArray(urls) ? urls.slice() : [urls];
    const img = document.createElement('img');
    img.className = className;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = name || '';
    img.src = sources.shift();
    img.addEventListener('error', function onErr() {
        if (sources.length > 0) {
            img.src = sources.shift();
            return;
        }
        img.replaceWith(monogramBadge(name, id, className === 'preview-img' ? 'item-id-badge-lg' : ''));
    });
    return img;
}

// ============ BLIP LIST ============
function renderBlipList(filter = '') {
    const container = document.getElementById('blipList');
    container.innerHTML = '';
    state.blips.forEach(cat => {
        const filtered = cat.list.filter(b =>
            b.name.toLowerCase().includes(filter.toLowerCase()) || String(b.id).includes(filter)
        );
        if (filtered.length === 0) return;

        const catEl = document.createElement('div');
        catEl.className = 'item-cat';
        catEl.textContent = cat.cat;
        container.appendChild(catEl);

        filtered.forEach(b => {
            const row = document.createElement('div');
            row.className = 'item-row';
            row.dataset.id = b.id;
            row.appendChild(buildThumb(blipImgUrl(b), b.name, b.id));
            const label = document.createElement('span');
            label.textContent = b.name;
            row.appendChild(label);
            if (b.animated) {
                const badge = document.createElement('span');
                badge.className = 'animated-badge';
                badge.title = 'Animated blip (moves/spins on the minimap)';
                badge.textContent = 'GIF';
                row.appendChild(badge);
            }
            row.addEventListener('click', () => selectBlip(b, row));
            container.appendChild(row);
        });
    });
}

function blipImgUrl(b) {
    const ext = b.animated ? 'gif' : 'png';
    return `https://docs-backend.fivem.net/blips/${b.icon}.${ext}`;
}

// Visual-only: sets state.selectedBlip and updates the name/icon. Shared by
// a normal list click and by loading an existing item into the form to edit.
function applyBlipSelection(b) {
    state.selectedBlip = b;
    document.querySelectorAll('#blipList .item-row').forEach(r => {
        r.classList.toggle('selected', String(r.dataset.id) === String(b.id));
    });
    const animatedLabel = b.animated ? ' 🎬 Animated' : '';
    document.getElementById('blipSelectedName').textContent = `${b.name} (ID: ${b.id})${animatedLabel}`;
    const icon = document.getElementById('blipPreviewIcon');
    icon.innerHTML = '';
    const img = buildThumb(blipImgUrl(b), b.name, b.id, 'preview-img');
    img.loading = 'eager'; // the single preview icon should load immediately
    icon.appendChild(img);
}

async function selectBlip(b, rowEl) {
    if (state.editing && state.editing.kind === 'blip') cancelEdit('blip');
    document.querySelectorAll('#blipList .item-row').forEach(r => r.classList.remove('selected'));
    rowEl.classList.add('selected');
    applyBlipSelection(b);
    updateBlipCodePreview();
    state.blipBase = null;
    state.blipOffset = { x: 0, y: 0, z: 0 };
    setOffsetInputs('blip');
    const coords = await nuiFetch('getPlayerCoords');
    if (coords) state.playerCoords = coords;
    sendBlipPreview();
}

document.getElementById('blipSearch').addEventListener('input', (e) => renderBlipList(e.target.value));
document.getElementById('blipColorSelect').addEventListener('change', () => { updateBlipCodePreview(); sendBlipPreview(); });
document.getElementById('blipLabel').addEventListener('input', () => { updateBlipCodePreview(); sendBlipPreview(); });
pairSliderNumber('blipScale', 'blipScaleNum', () => {
    document.getElementById('blipScaleVal').textContent = parseFloat(document.getElementById('blipScaleNum').value || 0).toFixed(1);
    updateBlipCodePreview();
    sendBlipPreview();
});
wireHeading('blip', () => { updateBlipCodePreview(); sendBlipPreview(); });
wireOffset('blip', () => { updateBlipCodePreview(); sendBlipPreview(); });
document.getElementById('blipCancelEditBtn').addEventListener('click', () => cancelEdit('blip'));

function getBlipFormData() {
    return {
        sprite: state.selectedBlip ? state.selectedBlip.id : 1,
        typeName: state.selectedBlip ? state.selectedBlip.name : 'Blip',
        color: document.getElementById('blipColorSelect').value,
        scale: document.getElementById('blipScaleNum').value,
        heading: document.getElementById('blipHeadingNum').value,
        label: document.getElementById('blipLabel').value,
        coords: computeCoords('blip')
    };
}

async function updateBlipCodePreview() {
    if (!state.selectedBlip) return;
    const res = await nuiFetch('generateCode', { type: 'blip', ...getBlipFormData() });
    if (res) document.getElementById('blipCodePreview').textContent = res.code;
}

const sendBlipPreview = debounce(() => {
    if (!state.selectedBlip) return;
    nuiFetch('previewBlip', getBlipFormData());
    setLiveBadge('blipLiveBadge', true);
}, 80);

document.getElementById('spawnBlipBtn').addEventListener('click', async () => {
    if (!state.selectedBlip) { showToast('Select a blip first'); return; }
    if (!(state.editing && state.editing.kind === 'blip')) {
        const res = await nuiFetch('getPlayerCoords');
        if (res) state.playerCoords = res;
    }
    const formData = getBlipFormData();

    if (state.editing && state.editing.kind === 'blip') {
        const oldUid = state.editing.uid;
        const rem = await nuiFetch('removeBlip', { uid: oldUid });
        if (rem && rem.error === 'no_permission') { showToast('⛔ No permission'); return; }
        const created = await nuiFetch('createBlip', formData);
        if (created && created.uid) {
            delete state.activeItems[oldUid];
            state.activeItems[created.uid] = { type: 'blip', label: state.selectedBlip.name, data: formData };
            cancelEdit('blip');
            showToast('✅ Blip updated for everyone on the server');
        } else {
            showToast('❌ Failed to save changes');
        }
        return;
    }

    const created = await nuiFetch('createBlip', formData);
    if (created && created.uid) {
        state.activeItems[created.uid] = { type: 'blip', label: state.selectedBlip.name, data: formData };
        nuiFetch('clearPreview', { kind: 'blip' });
        setLiveBadge('blipLiveBadge', false);
        showToast('✅ Blip added for everyone on the server');
    } else {
        showToast(created && created.error === 'no_permission' ? '⛔ No permission' : '❌ Failed to add blip');
    }
});

document.getElementById('copyBlipBtn').addEventListener('click', () => {
    const code = document.getElementById('blipCodePreview').textContent;
    if (!code) { showToast('Select a blip first'); return; }
    copyText(code);
});

// ============ MARKER LIST ============
function renderMarkerList(filter = '') {
    const container = document.getElementById('markerList');
    container.innerHTML = '';
    state.markers
        .filter(m => m.name.toLowerCase().includes(filter.toLowerCase()) || String(m.id).includes(filter))
        .forEach(m => {
            const row = document.createElement('div');
            row.className = 'item-row';
            row.dataset.id = m.id;
            row.appendChild(buildThumb(markerImgUrl(m.id), m.name, m.id));
            const label = document.createElement('span');
            label.textContent = m.name;
            row.appendChild(label);
            row.addEventListener('click', () => selectMarker(m, row));
            container.appendChild(row);
        });
}

function markerImgUrl(id) {
    return [
        `https://cdn.jsdelivr.net/gh/citizenfx/fivem-docs@master/static/markers/${id}.png`,
        `https://raw.githubusercontent.com/citizenfx/fivem-docs/master/static/markers/${id}.png`
    ];
}

// Visual-only: sets state.selectedMarker and updates the name/icon. Shared
// by a normal list click and by loading an existing item into the form.
function applyMarkerSelection(m) {
    state.selectedMarker = m;
    document.querySelectorAll('#markerList .item-row').forEach(r => {
        r.classList.toggle('selected', String(r.dataset.id) === String(m.id));
    });
    document.getElementById('markerSelectedName').textContent = `${m.name} (ID: ${m.id})`;
    const icon = document.getElementById('markerPreviewIcon');
    icon.innerHTML = '';
    const img = buildThumb(markerImgUrl(m.id), m.name, m.id, 'preview-img');
    img.loading = 'eager';
    icon.appendChild(img);
}

async function selectMarker(m, rowEl) {
    if (state.editing && state.editing.kind === 'marker') cancelEdit('marker');
    document.querySelectorAll('#markerList .item-row').forEach(r => r.classList.remove('selected'));
    rowEl.classList.add('selected');
    applyMarkerSelection(m);
    updateMarkerCodePreview();
    state.markerBase = null;
    state.markerOffset = { x: 0, y: 0, z: 0 };
    setOffsetInputs('marker');
    const coords = await nuiFetch('getPlayerCoords');
    if (coords) state.playerCoords = coords;
    sendMarkerPreview();
}

document.getElementById('markerSearch').addEventListener('input', (e) => renderMarkerList(e.target.value));

const onMarkerFieldChange = () => {
    updateMarkerColorPreview();
    updateMarkerCodePreview();
    sendMarkerPreview();
};
pairSliderNumber('markerR', 'markerRNum', onMarkerFieldChange);
pairSliderNumber('markerG', 'markerGNum', onMarkerFieldChange);
pairSliderNumber('markerB', 'markerBNum', onMarkerFieldChange);
pairSliderNumber('markerA', 'markerANum', onMarkerFieldChange);

// Quick uniform scale: moving this sets all three axes at once. The
// per-axis fields below stay independently editable for non-uniform shapes
// (e.g. a flat wide marker) - touching one of them doesn't move this slider
// back, it's a shortcut, not a locked link.
pairSliderNumber('markerScale', 'markerScaleNum', () => {
    const v = document.getElementById('markerScaleNum').value;
    document.getElementById('markerScaleVal').textContent = parseFloat(v || 0).toFixed(1);
    document.getElementById('markerScaleX').value = v;
    document.getElementById('markerScaleY').value = v;
    document.getElementById('markerScaleZ').value = v;
    onMarkerFieldChange();
});
['markerScaleX', 'markerScaleY', 'markerScaleZ'].forEach(id => {
    document.getElementById(id).addEventListener('input', onMarkerFieldChange);
});
wireHeading('marker', onMarkerFieldChange);
wireOffset('marker', onMarkerFieldChange);
document.getElementById('markerCancelEditBtn').addEventListener('click', () => cancelEdit('marker'));

function updateMarkerColorPreview() {
    const r = document.getElementById('markerRNum').value;
    const g = document.getElementById('markerGNum').value;
    const b = document.getElementById('markerBNum').value;
    const a = document.getElementById('markerANum').value / 255;
    document.getElementById('markerColorPreview').style.background = `rgba(${r},${g},${b},${a})`;
    document.getElementById('markerColorPreview').style.boxShadow = `0 0 16px rgba(${r},${g},${b},0.7)`;
}

function getMarkerFormData() {
    return {
        markerType: state.selectedMarker ? state.selectedMarker.id : 1,
        typeName: state.selectedMarker ? state.selectedMarker.name : 'Marker',
        r: document.getElementById('markerRNum').value,
        g: document.getElementById('markerGNum').value,
        b: document.getElementById('markerBNum').value,
        a: document.getElementById('markerANum').value,
        scaleX: document.getElementById('markerScaleX').value,
        scaleY: document.getElementById('markerScaleY').value,
        scaleZ: document.getElementById('markerScaleZ').value,
        heading: document.getElementById('markerHeadingNum').value,
        coords: computeCoords('marker')
    };
}

async function updateMarkerCodePreview() {
    if (!state.selectedMarker) return;
    const res = await nuiFetch('generateCode', { type: 'marker', ...getMarkerFormData() });
    if (res) document.getElementById('markerCodePreview').textContent = res.code;
}

const sendMarkerPreview = debounce(() => {
    if (!state.selectedMarker) return;
    nuiFetch('previewMarker', getMarkerFormData());
    setLiveBadge('markerLiveBadge', true);
}, 60);

document.getElementById('spawnMarkerBtn').addEventListener('click', async () => {
    if (!state.selectedMarker) { showToast('Select a marker first'); return; }
    if (!(state.editing && state.editing.kind === 'marker')) {
        const res = await nuiFetch('getPlayerCoords');
        if (res) state.playerCoords = res;
    }
    const formData = getMarkerFormData();

    if (state.editing && state.editing.kind === 'marker') {
        const oldUid = state.editing.uid;
        const rem = await nuiFetch('removeMarker', { uid: oldUid });
        if (rem && rem.error === 'no_permission') { showToast('⛔ No permission'); return; }
        const created = await nuiFetch('createMarker', formData);
        if (created && created.uid) {
            delete state.activeItems[oldUid];
            state.activeItems[created.uid] = { type: 'marker', label: state.selectedMarker.name, data: formData };
            cancelEdit('marker');
            showToast('✅ Marker updated for everyone on the server');
        } else {
            showToast('❌ Failed to save changes');
        }
        return;
    }

    const created = await nuiFetch('createMarker', formData);
    if (created && created.uid) {
        state.activeItems[created.uid] = { type: 'marker', label: state.selectedMarker.name, data: formData };
        nuiFetch('clearPreview', { kind: 'marker' });
        setLiveBadge('markerLiveBadge', false);
        showToast('✅ Marker added for everyone on the server');
    } else {
        showToast(created && created.error === 'no_permission' ? '⛔ No permission' : '❌ Failed to add marker');
    }
});

document.getElementById('copyMarkerBtn').addEventListener('click', () => {
    const code = document.getElementById('markerCodePreview').textContent;
    if (!code) { showToast('Select a marker first'); return; }
    copyText(code);
});

// ============ CHECKPOINT LIST ============
function checkpointImgUrl(id) {
    // docs-backend.fivem.net is the actual image host CitizenFX's own docs
    // page (docs.fivem.net/docs/game-references/checkpoints) embeds its
    // checkpoint icons from, so it's used as the primary source. The old
    // jsdelivr/GitHub paths pointed at a folder that doesn't exist in that
    // repo (checkpoint icons aren't stored there), which is why every
    // checkpoint fell back to the initials badge; they're kept below only
    // as a last-resort fallback in case the docs CDN is ever unreachable.
    return [
        `https://docs-backend.fivem.net/checkpoints/${id}.png`,
        `https://cdn.jsdelivr.net/gh/citizenfx/fivem-docs@master/checkpoints/${id}.png`,
        `https://raw.githubusercontent.com/citizenfx/fivem-docs/master/checkpoints/${id}.png`
    ];
}

function renderCheckpointList(filter = '') {
    const container = document.getElementById('checkpointList');
    container.innerHTML = '';
    state.checkpoints
        .filter(c => c.name.toLowerCase().includes(filter.toLowerCase()) || String(c.id).includes(filter))
        .forEach(c => {
            const row = document.createElement('div');
            row.className = 'item-row';
            row.dataset.id = c.id;
            row.appendChild(buildThumb(checkpointImgUrl(c.id), c.name, c.id));
            const label = document.createElement('span');
            label.textContent = c.name;
            row.appendChild(label);
            row.addEventListener('click', () => selectCheckpoint(c, row));
            container.appendChild(row);
        });
}

// Visual-only: sets state.selectedCheckpoint and updates the name/icon.
// Shared by a normal list click and by loading an existing item to edit.
function applyCheckpointSelection(c) {
    state.selectedCheckpoint = c;
    document.querySelectorAll('#checkpointList .item-row').forEach(r => {
        r.classList.toggle('selected', String(r.dataset.id) === String(c.id));
    });
    document.getElementById('checkpointSelectedName').textContent = `${c.name} (ID: ${c.id})`;
    const icon = document.getElementById('checkpointPreviewIcon');
    icon.innerHTML = '';
    const img = buildThumb(checkpointImgUrl(c.id), c.name, c.id, 'preview-img');
    img.loading = 'eager';
    icon.appendChild(img);
}

async function selectCheckpoint(c, rowEl) {
    if (state.editing && state.editing.kind === 'checkpoint') cancelEdit('checkpoint');
    document.querySelectorAll('#checkpointList .item-row').forEach(r => r.classList.remove('selected'));
    rowEl.classList.add('selected');
    applyCheckpointSelection(c);
    updateCheckpointCodePreview();
    state.checkpointBase = null;
    state.checkpointOffset = { x: 0, y: 0, z: 0 };
    setOffsetInputs('checkpoint');
    const coords = await nuiFetch('getPlayerCoords');
    if (coords) state.playerCoords = coords;
    sendCheckpointPreview();
}

document.getElementById('checkpointSearch').addEventListener('input', (e) => renderCheckpointList(e.target.value));

const onCheckpointFieldChange = () => {
    updateCheckpointColorPreview();
    updateCheckpointCodePreview();
    sendCheckpointPreview();
};
pairSliderNumber('checkpointR', 'checkpointRNum', onCheckpointFieldChange);
pairSliderNumber('checkpointG', 'checkpointGNum', onCheckpointFieldChange);
pairSliderNumber('checkpointB', 'checkpointBNum', onCheckpointFieldChange);
pairSliderNumber('checkpointA', 'checkpointANum', onCheckpointFieldChange);
pairSliderNumber('checkpointRadius', 'checkpointRadiusNum', () => {
    document.getElementById('checkpointRadiusVal').textContent = parseFloat(document.getElementById('checkpointRadiusNum').value || 0).toFixed(1);
    updateCheckpointCodePreview();
    sendCheckpointPreview();
});
wireHeading('checkpoint', onCheckpointFieldChange);
wireOffset('checkpoint', onCheckpointFieldChange);
document.getElementById('checkpointCancelEditBtn').addEventListener('click', () => cancelEdit('checkpoint'));

function updateCheckpointColorPreview() {
    const r = document.getElementById('checkpointRNum').value;
    const g = document.getElementById('checkpointGNum').value;
    const b = document.getElementById('checkpointBNum').value;
    const a = document.getElementById('checkpointANum').value / 255;
    document.getElementById('checkpointColorPreview').style.background = `rgba(${r},${g},${b},${a})`;
    document.getElementById('checkpointColorPreview').style.boxShadow = `0 0 16px rgba(${r},${g},${b},0.7)`;
}

function getCheckpointFormData() {
    return {
        checkpointType: state.selectedCheckpoint ? state.selectedCheckpoint.id : 0,
        typeName: state.selectedCheckpoint ? state.selectedCheckpoint.name : 'Checkpoint',
        r: document.getElementById('checkpointRNum').value,
        g: document.getElementById('checkpointGNum').value,
        b: document.getElementById('checkpointBNum').value,
        a: document.getElementById('checkpointANum').value,
        radius: document.getElementById('checkpointRadiusNum').value,
        heading: document.getElementById('checkpointHeadingNum').value,
        coords: computeCoords('checkpoint')
    };
}

async function updateCheckpointCodePreview() {
    if (!state.selectedCheckpoint) return;
    const res = await nuiFetch('generateCode', { type: 'checkpoint', ...getCheckpointFormData() });
    if (res) document.getElementById('checkpointCodePreview').textContent = res.code;
}

// Checkpoints are the priciest to preview (delete + recreate the native on
// every update), so this gets a longer debounce than blips/markers.
const sendCheckpointPreview = debounce(() => {
    if (!state.selectedCheckpoint) return;
    nuiFetch('previewCheckpoint', getCheckpointFormData());
    setLiveBadge('checkpointLiveBadge', true);
}, 150);

document.getElementById('spawnCheckpointBtn').addEventListener('click', async () => {
    if (!state.selectedCheckpoint) { showToast('Select a checkpoint first'); return; }
    if (!(state.editing && state.editing.kind === 'checkpoint')) {
        const res = await nuiFetch('getPlayerCoords');
        if (res) state.playerCoords = res;
    }
    const formData = getCheckpointFormData();

    if (state.editing && state.editing.kind === 'checkpoint') {
        const oldUid = state.editing.uid;
        const rem = await nuiFetch('removeCheckpoint', { uid: oldUid });
        if (rem && rem.error === 'no_permission') { showToast('⛔ No permission'); return; }
        const created = await nuiFetch('createCheckpoint', formData);
        if (created && created.uid) {
            delete state.activeItems[oldUid];
            state.activeItems[created.uid] = { type: 'checkpoint', label: state.selectedCheckpoint.name, data: formData };
            cancelEdit('checkpoint');
            showToast('✅ Checkpoint updated for everyone on the server');
        } else {
            showToast('❌ Failed to save changes');
        }
        return;
    }

    const created = await nuiFetch('createCheckpoint', formData);
    if (created && created.uid) {
        state.activeItems[created.uid] = { type: 'checkpoint', label: state.selectedCheckpoint.name, data: formData };
        nuiFetch('clearPreview', { kind: 'checkpoint' });
        setLiveBadge('checkpointLiveBadge', false);
        showToast('✅ Checkpoint added for everyone on the server');
    } else {
        showToast(created && created.error === 'no_permission' ? '⛔ No permission' : '❌ Failed to add checkpoint');
    }
});

document.getElementById('copyCheckpointBtn').addEventListener('click', () => {
    const code = document.getElementById('checkpointCodePreview').textContent;
    if (!code) { showToast('Select a checkpoint first'); return; }
    copyText(code);
});

// ============ ACTIVE ITEMS ============
function renderActiveList() {
    const container = document.getElementById('activeList');
    container.innerHTML = '';
    const keys = Object.keys(state.activeItems);
    if (keys.length === 0) {
        container.innerHTML = '<div class="empty-state">No blips or markers added yet</div>';
        return;
    }
    keys.forEach(uid => {
        const item = state.activeItems[uid];
        const row = document.createElement('div');
        row.className = 'active-item';
        const typeIcon = item.type === 'blip' ? '📍' : (item.type === 'marker' ? '◆' : '◎');
        const typeLabel = item.type === 'blip' ? 'Blip' : (item.type === 'marker' ? 'Marker' : 'Checkpoint');
        row.innerHTML = `
            <div>
                <div>${typeIcon} ${item.label}</div>
                <div class="meta">${typeLabel} • ${uid}</div>
            </div>
            <div class="active-item-btns">
                <button class="edit-btn">✏️ Edit</button>
                <button class="remove-btn">Remove</button>
            </div>
        `;
        row.querySelector('.edit-btn').addEventListener('click', () => startEdit(uid));
        row.querySelector('.remove-btn').addEventListener('click', async () => {
            const endpoint = item.type === 'blip' ? 'removeBlip' : (item.type === 'marker' ? 'removeMarker' : 'removeCheckpoint');
            const res = await nuiFetch(endpoint, { uid });
            if (res && res.error === 'no_permission') {
                showToast('⛔ No permission');
                return;
            }
            delete state.activeItems[uid];
            if (state.editing && state.editing.uid === uid) cancelEdit(state.editing.kind);
            renderActiveList();
            showToast('Removed for everyone');
        });
        container.appendChild(row);
    });
}

document.getElementById('clearAllBtn').addEventListener('click', async () => {
    const res = await nuiFetch('clearAll');
    if (res && res.error === 'no_permission') {
        showToast('⛔ No permission');
        return;
    }
    state.activeItems = {};
    if (state.editing) cancelEdit(state.editing.kind);
    renderActiveList();
    showToast('Everything cleared for everyone');
});

document.getElementById('exportBtn').addEventListener('click', async () => {
    const res = await nuiFetch('exportSaved');
    const preview = document.getElementById('exportCodePreview');
    if (!res || res.error === 'empty') {
        showToast('Nothing saved to export yet');
        return;
    }
    if (res.error === 'no_permission') {
        showToast('⛔ No permission');
        return;
    }
    preview.textContent = res.code;
    showToast(`💾 Saved ${res.count} item(s) to ${res.path}`);
});

document.getElementById('copyExportBtn').addEventListener('click', () => {
    const code = document.getElementById('exportCodePreview').textContent;
    if (!code) { showToast('Nothing exported yet'); return; }
    copyText(code);
});

// ============ COPY TO CLIPBOARD ============
function copyText(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
        document.execCommand('copy');
        showToast('📋 Code copied');
    } catch (e) {
        showToast('Copy failed');
    }
    document.body.removeChild(ta);
}

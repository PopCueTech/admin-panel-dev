// ═════════════════════════════════════════════════════════
// PROFILE ATTRIBUTES (admin page + survey-creation targeting)
// ═════════════════════════════════════════════════════════

function escapePaHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// ─── Standalone "Profile Attributes" admin page ─────────────────────

async function showProfileAttributes() {
    hideAllSections();
    document.getElementById('profileAttributesSection').style.display = 'block';
    setActiveTab('profile-attributes');
    await loadProfileAttributesList();
}

async function loadProfileAttributesList() {
    const container = document.getElementById('profileAttributesList');
    if (!container) return;
    container.innerHTML = '<p style="text-align:center; padding:40px; color:#999;">Loading profile attributes...</p>';
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/profile-attributes`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const attributes = await response.json();

        if (!attributes || attributes.length === 0) {
            container.innerHTML = '<p style="text-align:center; padding:40px; color:#999;">No profile attributes recorded yet.</p>';
            return;
        }

        container.innerHTML = attributes.map(attr => `
            <div class="details-card" style="margin-bottom:16px;">
                <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px;">
                    <h3 style="margin:0;"><code>${escapePaHtml(attr.key)}</code></h3>
                    <span style="color:#666; font-size:13px;">${attr.total_respondents} respondent${attr.total_respondents === 1 ? '' : 's'}</span>
                </div>
                ${attr.values.length === 0
                    ? '<p style="color:#999; font-size:13px; margin:0;">No values submitted yet.</p>'
                    : `<table class="surveys-table">
                        <thead><tr><th>Value</th><th style="width:120px;">Count</th></tr></thead>
                        <tbody>
                            ${attr.values.map(v => `
                                <tr>
                                    <td>${escapePaHtml(v.value)}</td>
                                    <td>${v.count}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>`
                }
            </div>
        `).join('');
    } catch (error) {
        container.innerHTML = `<p style="text-align:center; padding:40px; color:#c62828;">Failed to load profile attributes: ${escapePaHtml(error.message)}</p>`;
    }
}

// ─── Survey-creation "Target by Profile Attribute" condition builder ─

let _paConditionCounter = 0;
let _paAttributesCache = null;

async function _paLoadAttributes() {
    if (_paAttributesCache) return _paAttributesCache;
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/profile-attributes`);
        if (!response.ok) return [];
        _paAttributesCache = await response.json();
        return _paAttributesCache;
    } catch (e) {
        console.warn('[profile_attributes] failed to load attributes:', e);
        return [];
    }
}

function _paRenderValueToggles(valuesContainer, values) {
    valuesContainer.innerHTML = values.map((v, i) => `
        <label class="pa-value-toggle">
            <span class="pa-value-toggle-label">${escapePaHtml(v.value)} <span style="color:#9ca3af;">(${v.count})</span></span>
            <span class="pa-switch">
                <input type="checkbox" class="pa-condition-value-checkbox" value="${escapePaHtml(v.value)}">
                <span class="pa-switch-slider"></span>
            </span>
        </label>
    `).join('');
}

async function addAttributeCondition() {
    const container = document.getElementById('attributeConditions');
    if (!container) return;

    const attributes = await _paLoadAttributes();
    const conditionId = `paCondition_${++_paConditionCounter}`;

    const row = document.createElement('div');
    row.id = conditionId;
    row.className = 'pa-condition-row';
    row.innerHTML = `
        <div class="pa-condition-row-header">
            <select class="pa-condition-key">
                <option value="">Select attribute…</option>
                ${attributes.map(a => `<option value="${escapePaHtml(a.key)}">${escapePaHtml(a.key)}</option>`).join('')}
            </select>
            <button type="button" class="btn btn-ghost btn-sm" style="color:#c62828;" onclick="document.getElementById('${conditionId}').remove()">✕</button>
        </div>
        <div class="pa-value-toggles"></div>
    `;
    container.appendChild(row);

    const keySelect = row.querySelector('.pa-condition-key');
    const valuesContainer = row.querySelector('.pa-value-toggles');
    keySelect.addEventListener('change', () => {
        const attr = attributes.find(a => a.key === keySelect.value);
        _paRenderValueToggles(valuesContainer, attr ? attr.values : []);
    });
}

function resetAttributeConditions() {
    const container = document.getElementById('attributeConditions');
    if (container) container.innerHTML = '';
    _paAttributesCache = null;
}

function getTargetAttributesFromForm() {
    const container = document.getElementById('attributeConditions');
    if (!container) return null;

    const conditions = [];
    container.querySelectorAll(':scope > .pa-condition-row').forEach(row => {
        const key = row.querySelector('.pa-condition-key')?.value;
        const values = Array.from(row.querySelectorAll('.pa-condition-value-checkbox:checked')).map(cb => cb.value);
        if (key && values.length > 0) {
            conditions.push({ key, values });
        }
    });
    return conditions.length > 0 ? conditions : null;
}

// Reset conditions when tenant changes, same as panel selector
if (document.getElementById('tenantId')) {
    document.getElementById('tenantId').addEventListener('change', resetAttributeConditions);
}

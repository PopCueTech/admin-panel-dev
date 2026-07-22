// ═════════════════════════════════════════════════════════
// PROFILE QUESTIONNAIRES
// ═════════════════════════════════════════════════════════
//
// Profile questionnaires populate user_profiles.profile_attributes (a flexible
// JSONB key/value store) — they do NOT feed survey analytics. Each question
// carries an `attribute_key` that names the JSONB key on the user profile.
//
// Backend endpoints used:
//   GET  /api/v1/admin/surveys                (filtered to survey_kind='profile')
//   GET  /api/v1/admin/profile-attributes/keys (autocomplete hint)
//   GET  /api/v1/auth/tenants                  (tenant dropdown)
//   POST /api/v1/admin/profile-surveys         (manual create — no AI)

const PQ_QUESTION_TYPES = [
    { value: 'single_select', label: 'Single select' },
    { value: 'multi_select',  label: 'Multi select' },
    { value: 'mcq', label: 'Multiple choice' },
    { value: 'rating', label: 'Rating (1–5)' },
    { value: 'text', label: 'Text input' },
    { value: 'slider', label: 'Slider' },
    { value: 'imageSelection', label: 'Image selection' },
    { value: 'ranking', label: 'Ranking' },
];

const PQ_ATTRIBUTE_KEY_REGEX = /^[a-z][a-z0-9_]*$/;

let _pqQuestionCounter = 0;

// ─── Section entry / toggling ───────────────────────────────────────

async function showProfileQuestionnaires() {
    hideAllSections();
    const section = document.getElementById('profileQuestionnairesSection');
    if (section) section.style.display = 'block';
    setActiveTab('profile-questionnaires');

    document.getElementById('profileQuestionnaireListView').style.display = 'block';
    document.getElementById('profileQuestionnaireFormView').style.display = 'none';

    await loadProfileQuestionnairesList();
}

async function showProfileQuestionnaireForm() {
    // Stay inside the section, swap inner view from list → form
    document.getElementById('profileQuestionnaireListView').style.display = 'none';
    document.getElementById('profileQuestionnaireFormView').style.display = 'block';

    // Reset form state
    document.getElementById('pqTitle').value = '';
    document.getElementById('pqDescription').value = '';
    document.getElementById('pqPoints').value = 0;
    const publishEl = document.getElementById('pqPublish');
    if (publishEl) publishEl.checked = true;
    document.getElementById('pqQuestionCards').innerHTML = '';
    _pqQuestionCounter = 0;

    await populatePqTenantSelect();
    await loadProfileAttributeKeysHint();

    // Start with one default question card
    addProfileQuestionCard();
}

function closeProfileQuestionnaireForm() {
    document.getElementById('profileQuestionnaireFormView').style.display = 'none';
    document.getElementById('profileQuestionnaireListView').style.display = 'block';
}

// ─── List view ──────────────────────────────────────────────────────

async function loadProfileQuestionnairesList() {
    const tbody = document.getElementById('profileQuestionnairesTableBody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; padding:40px; color:#999;">Loading…</td></tr>';

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/surveys`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const surveys = await response.json();

        // Backend's admin endpoint may not yet return survey_kind on the row;
        // also accept the metadata fallback embedded in current_version.structure
        const profileSurveys = (surveys || []).filter(s =>
            s.survey_kind === 'profile' ||
            (s.current_version &&
             s.current_version.structure &&
             s.current_version.structure.metadata &&
             s.current_version.structure.metadata.kind === 'profile')
        );

        if (profileSurveys.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" style="text-align:center; padding:40px; color:#999;">
                        No profile questionnaires yet. Click <strong>+ Create profile questionnaire</strong> to add one.
                    </td>
                </tr>`;
            return;
        }

        tbody.innerHTML = profileSurveys.map(s => `
            <tr>
                <td><strong>${escapePqHtml(s.title || 'Untitled')}</strong></td>
                <td>${s.questions_count || 0}</td>
                <td>${s.is_active
                    ? '<span class="badge badge-success">Published</span>'
                    : '<span class="badge badge-warning">Draft</span>'}</td>
                <td>${s.completed_count || 0}</td>
                <td>${s.points || 0}</td>
                <td style="font-size:12px; color:#666;">
                    ${s.created_at ? new Date(s.created_at).toLocaleDateString() : 'N/A'}
                </td>
                <td style="display:flex; gap:6px; flex-wrap:wrap;">
                    <button class="btn-ghost" onclick="showProfileQuestionnaireDetail('${s.id}')">Review</button>
                    ${!s.is_active
                        ? `<button class="btn-ghost btn-ghost-brand" onclick="publishProfileQuestionnaire('${s.id}')">Publish</button>`
                        : `<button class="btn-ghost" onclick="unpublishProfileQuestionnaire('${s.id}')" style="color:#c62828;">Unpublish</button>`
                    }
                    ${s.is_active
                        ? `<button class="btn-ghost" onclick="alertRemainingProfileUsers('${s.id}')">🔔 Alert remaining</button>`
                        : ''
                    }
                </td>
            </tr>
        `).join('');
    } catch (error) {
        tbody.innerHTML = `
            <tr><td colspan="7" style="text-align:center; padding:40px; color:#c62828;">
                Failed to load: ${escapePqHtml(error.message)}
            </td></tr>`;
        console.error('[profile_questionnaire] list load failed:', error);
    }
}

// ─── Form helpers ───────────────────────────────────────────────────

async function populatePqTenantSelect() {
    const select = document.getElementById('pqTenantId');
    if (!select) return;
    select.innerHTML = '<option value="">Select organization</option>';
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/auth/tenants`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const tenants = data.tenants || data || [];
        tenants.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            opt.textContent = t.name || `Tenant ${String(t.id).substring(0, 8)}`;
            select.appendChild(opt);
        });
        if (tenants.length > 0) select.value = tenants[0].id;
    } catch (e) {
        console.warn('[profile_questionnaire] tenant load failed:', e);
    }
}

async function loadProfileAttributeKeysHint() {
    const hint = document.getElementById('pqExistingKeysHint');
    if (!hint) return;
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/profile-attributes/keys`);
        if (!response.ok) {
            hint.textContent = '';
            return;
        }
        const data = await response.json();
        const keys = data.keys || [];
        if (keys.length === 0) {
            hint.textContent = 'No attribute_keys used yet — these become keys on user_profiles.profile_attributes.';
        } else {
            hint.innerHTML = `<strong>Existing keys:</strong> ${keys.map(k => `<code>${escapePqHtml(k)}</code>`).join(', ')}`;
        }
    } catch (e) {
        hint.textContent = '';
    }
}

// ─── Question cards ─────────────────────────────────────────────────

function addProfileQuestionCard() {
    _pqQuestionCounter++;
    const id = _pqQuestionCounter;
    const cards = document.getElementById('pqQuestionCards');
    const typeOptions = PQ_QUESTION_TYPES
        .map(t => `<option value="${t.value}">${t.label}</option>`).join('');

    const card = document.createElement('div');
    card.className = 'pq-question-card';
    card.id = `pq-q-${id}`;
    card.style.cssText = 'border:1px solid #e5e7eb; border-radius:8px; padding:12px; margin-bottom:10px; background:#f9fafb;';

    card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <strong>Question ${cards.children.length + 1}</strong>
            <button type="button" class="btn btn-ghost btn-sm" onclick="removeProfileQuestionCard(${id})" style="color:#c62828; padding:2px 8px;">Remove</button>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label style="font-size:0.85rem;">Question title *</label>
                <input type="text" id="pq-title-${id}" placeholder="e.g. What's your dietary preference?">
            </div>
            <div class="form-group">
                <label style="font-size:0.85rem;">Type *</label>
                <select id="pq-type-${id}" onchange="onPqTypeChange(${id})">
                    ${typeOptions}
                </select>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label style="font-size:0.85rem;">attribute_key * <small style="color:#666; font-weight:400;">(snake_case, becomes the JSONB key)</small></label>
                <input type="text" id="pq-attrkey-${id}" placeholder="e.g. dietary_preference" pattern="^[a-z][a-z0-9_]*$">
            </div>
            <div class="form-group">
                <label style="font-size:0.85rem; display:flex; align-items:center; gap:6px; margin-top:24px;">
                    <input type="checkbox" id="pq-required-${id}" checked> Required
                </label>
            </div>
        </div>
        <div id="pq-typeconfig-${id}" style="margin-top:8px;"></div>
    `;
    cards.appendChild(card);
    onPqTypeChange(id);
}

function removeProfileQuestionCard(id) {
    const cards = document.getElementById('pqQuestionCards');
    if (cards.children.length <= 1) {
        showToast('At least one question is required', 'error');
        return;
    }
    const target = document.getElementById(`pq-q-${id}`);
    if (target) target.remove();
}

function onPqTypeChange(id) {
    const typeEl = document.getElementById(`pq-type-${id}`);
    const wrap = document.getElementById(`pq-typeconfig-${id}`);
    if (!typeEl || !wrap) return;
    const type = typeEl.value;

    if (type === 'mcq' || type === 'single_select' || type === 'multi_select') {
        wrap.innerHTML = `
            <label style="font-size:0.85rem;">Options (one per line) *</label>
            <textarea id="pq-options-${id}" rows="4" placeholder="Option A&#10;Option B&#10;Option C"></textarea>
        `;
    } else if (type === 'slider') {
        wrap.innerHTML = `
            <div class="form-row">
                <div class="form-group"><label style="font-size:0.85rem;">Min</label>
                    <input type="number" id="pq-min-${id}" value="1"></div>
                <div class="form-group"><label style="font-size:0.85rem;">Max</label>
                    <input type="number" id="pq-max-${id}" value="10"></div>
                <div class="form-group"><label style="font-size:0.85rem;">Step</label>
                    <input type="number" id="pq-step-${id}" value="1"></div>
            </div>
        `;
    } else if (type === 'rating') {
        wrap.innerHTML = `<small style="color:#666;">Rating uses a fixed 1–5 scale.</small>`;
    } else {
        wrap.innerHTML = `<small style="color:#666;">No additional configuration needed for this question type.</small>`;
    }
}

// ─── Submit ─────────────────────────────────────────────────────────

function _collectPqQuestion(cardId) {
    const titleEl = document.getElementById(`pq-title-${cardId}`);
    const typeEl = document.getElementById(`pq-type-${cardId}`);
    const attrKeyEl = document.getElementById(`pq-attrkey-${cardId}`);
    const reqEl = document.getElementById(`pq-required-${cardId}`);
    if (!titleEl || !typeEl || !attrKeyEl) return null;

    const title = titleEl.value.trim();
    const type = typeEl.value;
    const attribute_key = attrKeyEl.value.trim();

    if (!title) throw new Error('A question is missing its title');
    if (!attribute_key) throw new Error(`Question "${title}" is missing an attribute_key`);
    if (!PQ_ATTRIBUTE_KEY_REGEX.test(attribute_key)) {
        throw new Error(`attribute_key "${attribute_key}" must be snake_case (a-z, 0-9, _; start with a letter)`);
    }

    const data = {};
    if (type === 'mcq' || type === 'single_select' || type === 'multi_select') {
        const raw = (document.getElementById(`pq-options-${cardId}`)?.value || '').trim();
        const opts = raw.split('\n').map(s => s.trim()).filter(Boolean);
        if (opts.length < 2) throw new Error(`Question "${title}" needs at least 2 options`);
        data.options = opts.map((label, i) => ({ id: `opt_${i + 1}`, label }));
    } else if (type === 'slider') {
        data.min = Number(document.getElementById(`pq-min-${cardId}`)?.value || 1);
        data.max = Number(document.getElementById(`pq-max-${cardId}`)?.value || 10);
        data.step = Number(document.getElementById(`pq-step-${cardId}`)?.value || 1);
    }

    return {
        id: `q_${attribute_key}`,
        type,
        title,
        attribute_key,
        required: !!(reqEl && reqEl.checked),
        data,
    };
}

async function submitProfileQuestionnaire() {
    const title = document.getElementById('pqTitle').value.trim();
    const description = document.getElementById('pqDescription').value.trim();
    const points = Number(document.getElementById('pqPoints').value) || 0;
    const tenant_id = document.getElementById('pqTenantId').value;
    const publish = document.getElementById('pqPublish').checked;

    if (!title || title.length < 3) {
        showToast('Title is required (min 3 chars)', 'error');
        return;
    }
    if (!tenant_id) {
        showToast('Please select a tenant', 'error');
        return;
    }

    const cards = document.getElementById('pqQuestionCards').children;
    const questions = [];
    try {
        for (const card of cards) {
            const cardId = Number(card.id.replace('pq-q-', ''));
            const q = _collectPqQuestion(cardId);
            if (q) questions.push(q);
        }
    } catch (e) {
        showToast(e.message, 'error');
        return;
    }
    if (questions.length === 0) {
        showToast('Add at least one question', 'error');
        return;
    }

    const seen = new Set();
    for (const q of questions) {
        if (seen.has(q.attribute_key)) {
            showToast(`Duplicate attribute_key: ${q.attribute_key}`, 'error');
            return;
        }
        seen.add(q.attribute_key);
    }

    const payload = {
        title,
        description: description || null,
        points,
        tenant_id,
        questions,
        publish,
    };

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/profile-surveys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${response.status}`);
        }
        const data = await response.json();
        showToast(`✅ Created profile questionnaire (${data.questions_count} questions)`, 'success');
        closeProfileQuestionnaireForm();
        await loadProfileQuestionnairesList();
    } catch (e) {
        showToast(`Failed: ${e.message}`, 'error');
    }
}

// ─── Detail / Review view ────────────────────────────────────────────

async function showProfileQuestionnaireDetail(surveyId) {
    window._pqDetailId = surveyId;

    document.getElementById('profileQuestionnaireListView').style.display = 'none';
    document.getElementById('profileQuestionnaireFormView').style.display = 'none';
    const detailView = document.getElementById('profileQuestionnaireDetailView');
    detailView.style.display = 'block';

    document.getElementById('pqDetailTitle').textContent = 'Loading…';
    document.getElementById('pqDetailDescription').textContent = '';
    document.getElementById('pqDetailQuestions').innerHTML = '';

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const s = await response.json();

        document.getElementById('pqDetailTitle').textContent = s.title || 'Untitled';
        document.getElementById('pqDetailDescription').textContent = s.description || 'No description';
        document.getElementById('pqDetailPoints').textContent = s.points || 0;
        document.getElementById('pqDetailCreated').textContent = s.created_at ? new Date(s.created_at).toLocaleDateString() : 'N/A';

        const badge = document.getElementById('pqDetailStatusBadge');
        if (s.is_active) {
            badge.textContent = 'Published';
            badge.className = 'badge badge-success';
        } else {
            badge.textContent = 'Draft';
            badge.className = 'badge badge-warning';
        }

        document.getElementById('pqDetailPublishBtn').style.display = s.is_active ? 'none' : 'inline-block';
        document.getElementById('pqDetailUnpublishBtn').style.display = s.is_active ? 'inline-block' : 'none';
        document.getElementById('pqDetailNotifyRemainingBtn').style.display = s.is_active ? 'inline-block' : 'none';

        const questions = (s.current_version && s.current_version.structure && s.current_version.structure.questions) || [];
        document.getElementById('pqDetailQCount').textContent = questions.length;

        const container = document.getElementById('pqDetailQuestions');
        if (questions.length === 0) {
            container.innerHTML = '<p style="color:#999;">No questions found.</p>';
        } else {
            container.innerHTML = questions.map((q, idx) => {
                const options = q.data && q.data.options ? q.data.options : (q.answers || q.options || []);
                const optionsHTML = options.length > 0
                    ? `<div style="margin-top:8px; padding-left:12px; border-left:2px solid #e5e7eb;">
                        ${options.map(o => `<div style="font-size:0.9em; color:#555; padding:3px 0;">• ${escapePqHtml(o.label || o.text || String(o))}</div>`).join('')}
                       </div>`
                    : '';
                const sliderHTML = (q.type === 'slider' && q.data)
                    ? `<div style="font-size:0.85em; color:#666; margin-top:4px;">Range: ${q.data.min ?? 1} – ${q.data.max ?? 10}, step ${q.data.step ?? 1}</div>`
                    : '';
                return `
                    <div style="background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:14px; margin-bottom:10px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                            <strong>Q${idx + 1}: ${escapePqHtml(q.title || q.label || q.text || 'Untitled')}</strong>
                            <div style="display:flex; gap:6px; flex-shrink:0;">
                                <span style="font-size:0.8em; background:#f3f4f6; border-radius:4px; padding:2px 6px;">${escapePqHtml(q.type)}</span>
                                ${q.required ? '<span style="font-size:0.8em; background:#fef3c7; border-radius:4px; padding:2px 6px;">required</span>' : ''}
                            </div>
                        </div>
                        ${q.attribute_key ? `<div style="font-size:0.8em; color:#888; margin-bottom:4px;">attribute_key: <code>${escapePqHtml(q.attribute_key)}</code></div>` : ''}
                        ${optionsHTML}
                        ${sliderHTML}
                    </div>
                `;
            }).join('');
        }
    } catch (e) {
        document.getElementById('pqDetailTitle').textContent = 'Failed to load';
        document.getElementById('pqDetailQuestions').innerHTML = `<p style="color:#c62828;">${escapePqHtml(e.message)}</p>`;
        console.error('[profile_questionnaire] detail load failed:', e);
    }
}

function closeProfileQuestionnaireDetail() {
    document.getElementById('profileQuestionnaireDetailView').style.display = 'none';
    document.getElementById('profileQuestionnaireListView').style.display = 'block';
}

// ─── Publish / Unpublish ─────────────────────────────────────────────

async function publishProfileQuestionnaire(surveyId) {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${response.status}`);
        }
        const data = await response.json();
        showToast(`✅ ${data.message || 'Published'}`, 'success');
        const inDetail = document.getElementById('profileQuestionnaireDetailView').style.display !== 'none';
        if (inDetail) {
            await showProfileQuestionnaireDetail(surveyId);
        } else {
            await loadProfileQuestionnairesList();
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
        console.error('[profile_questionnaire] publish failed:', e);
    }
}

async function unpublishProfileQuestionnaire(surveyId) {
    if (!confirm('Unpublish this profile questionnaire? Users won\'t see it anymore.')) return;
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${response.status}`);
        }
        showToast('Questionnaire moved to draft', 'success');
        const inDetail = document.getElementById('profileQuestionnaireDetailView').style.display !== 'none';
        if (inDetail) {
            await showProfileQuestionnaireDetail(surveyId);
        } else {
            await loadProfileQuestionnairesList();
        }
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
        console.error('[profile_questionnaire] unpublish failed:', e);
    }
}

async function alertRemainingProfileUsers(surveyId) {
    if (!confirm('Alert all users who haven\'t completed this profile questionnaire yet?')) return;
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/profile-surveys/${surveyId}/notify-remaining`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${response.status}`);
        }
        const data = await response.json();
        showToast(`✅ ${data.message}`, 'success');
    } catch (e) {
        showToast(`Error: ${e.message}`, 'error');
        console.error('[profile_questionnaire] alert remaining failed:', e);
    }
}

// ─── XSS-safe escape (locally named to avoid clobbering anything) ─

function escapePqHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

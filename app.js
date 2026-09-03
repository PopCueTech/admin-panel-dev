// ═════════════════════════════════════════════════════════
// CONFIGURATION
// ═════════════════════════════════════════════════════════

const API_URL_PROD = 'https://popcue-api-prod-g7mtgi7cwa-uc.a.run.app';
const API_URL_DEV = 'https://popcue-api-812411253957.us-central1.run.app';
const TOKEN_KEY = 'popcue_admin_token';
const REFRESH_TOKEN_KEY = 'popcue_admin_refresh_token';
const USER_KEY = 'popcue_admin_user';
const TENANT_ID_KEY = 'popcue_admin_tenant_id';
const ENV_KEY = 'popcue_admin_env';

let API_BASE_URL = API_URL_PROD;
let currentUser = null;
let currentToken = null;
let currentSurveyData = null;
let currentSurveyMetrics = null;
let refreshTimer = null;
let allSurveys = [];  // Store for client-side filtering

// Analytics engine configuration
const ANALYTICS_ENGINE_URL = 'https://analytics-engine-p-812411253957.us-central1.run.app';
const ANALYTICS_POLL_INTERVAL_MS = 5000;
let currentAnalyticsJobId = null;
let analyticsPollInterval = null;

// ═════════════════════════════════════════════════════════
// ANALYTICS JOB PERSISTENCE (localStorage)
// ═════════════════════════════════════════════════════════

const ANALYTICS_JOB_PREFIX = 'popcue_analytics_job_';
const ANALYTICS_JOB_STALE_HOURS = 2; // Clear stale jobs older than this

function saveAnalyticsJob(surveyId, jobId) {
    localStorage.setItem(`${ANALYTICS_JOB_PREFIX}${surveyId}`, JSON.stringify({
        jobId, surveyId, startedAt: new Date().toISOString()
    }));
}

function getAnalyticsJob(surveyId) {
    const raw = localStorage.getItem(`${ANALYTICS_JOB_PREFIX}${surveyId}`);
    if (!raw) return null;
    try {
        const job = JSON.parse(raw);
        // Staleness check: if job is older than ANALYTICS_JOB_STALE_HOURS, discard it
        if (job.startedAt) {
            const ageHours = (Date.now() - new Date(job.startedAt).getTime()) / (1000 * 60 * 60);
            if (ageHours > ANALYTICS_JOB_STALE_HOURS) {
                console.log(`[Analytics] Clearing stale job for survey ${surveyId} (age: ${ageHours.toFixed(1)}h)`);
                clearAnalyticsJob(surveyId);
                return null;
            }
        }
        return job;
    } catch (e) {
        clearAnalyticsJob(surveyId);
        return null;
    }
}

function clearAnalyticsJob(surveyId) {
    localStorage.removeItem(`${ANALYTICS_JOB_PREFIX}${surveyId}`);
}

/**
 * Check for existing analytics state when loading survey details.
 * 1. If localStorage has a saved running job → resume polling
 * 2. If no saved job → check GCS for an existing PDF report
 * 3. Updates the analytics card UI accordingly
 */
async function checkExistingAnalyticsState(surveyId) {
    const analyticsCard = document.getElementById('analyticsCard');
    const analyticsContent = document.getElementById('analyticsContent');
    const downloadPdfBtn = document.getElementById('downloadAnalyticsPdfBtn');
    const refreshBtn = document.getElementById('analyticsRefreshBtn');
    const pipelineSteps = document.getElementById('pipelineSteps');

    // 1. Check localStorage for a saved job
    const savedJob = getAnalyticsJob(surveyId);
    if (savedJob) {
        console.log(`[Analytics] Found saved job for survey ${surveyId}: ${savedJob.jobId}`);
        currentAnalyticsJobId = savedJob.jobId;

        // Try to get the job's current status from the engine
        try {
            const response = await fetch(
                `${ANALYTICS_ENGINE_URL}/pipeline/status/${savedJob.jobId}`
            );

            if (response.ok) {
                const data = await response.json();

                if (data.status === 'running') {
                    // Job is still running — resume polling
                    analyticsCard.style.display = 'block';
                    refreshBtn.style.display = 'inline-block';
                    pipelineSteps.style.display = 'block';
                    renderPipelineSteps(data.steps || []);
                    updateAnalyticsContent(`⏳ Pipeline still running — Job: ${savedJob.jobId}`);
                    startAnalyticsPolling();
                    return;
                } else if (['completed', 'failed', 'partial_failure'].includes(data.status)) {
                    // Job finished — show final state and clear localStorage
                    clearAnalyticsJob(surveyId);
                    currentAnalyticsJobId = savedJob.jobId; // Keep for display

                    const statusEmoji = { completed: '✅', failed: '❌', partial_failure: '⚠️' };
                    const emoji = statusEmoji[data.status] || '🔄';
                    const duration = data.duration_seconds ? ` (${Math.round(data.duration_seconds)}s)` : '';

                    analyticsCard.style.display = 'block';
                    refreshBtn.style.display = 'inline-block';
                    updateAnalyticsContent(
                        `${emoji} Status: <strong>${data.status}</strong>${duration} — Job: ${savedJob.jobId}`
                    );

                    if (data.steps && data.steps.length > 0) {
                        pipelineSteps.style.display = 'block';
                        renderPipelineSteps(data.steps);
                    }
                    if (data.output_files && Object.keys(data.output_files).length > 0) {
                        renderAnalyticsResults(data);
                    }
                    if (data.output_files?.pdf_report) {
                        downloadPdfBtn.style.display = 'inline-block';
                    }
                    return;
                }
            } else {
                // Engine returned error (404 = job expired/not found) — clear stale job
                console.warn(`[Analytics] Engine returned ${response.status} for job ${savedJob.jobId}, clearing`);
                clearAnalyticsJob(surveyId);
                currentAnalyticsJobId = null;
            }
        } catch (err) {
            console.warn('[Analytics] Failed to poll saved job status:', err);
            clearAnalyticsJob(surveyId);
            currentAnalyticsJobId = null;
        }
    }

    // 2. No running job — check if a completed PDF report exists in GCS
    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/surveys/${surveyId}/analytics/download/pdf`
        );

        if (response.ok) {
            // PDF report exists — show "Report available" state
            analyticsCard.style.display = 'block';
            downloadPdfBtn.style.display = 'inline-block';
            updateAnalyticsContent(
                '✅ <strong>Analytics report available.</strong> Click "📄 Download PDF" to view the report.'
            );
            console.log(`[Analytics] Existing PDF report found for survey ${surveyId}`);
            return;
        }
    } catch (err) {
        // GCS check failed — not critical, just show default state
        console.warn('[Analytics] Failed to check for existing report:', err);
    }

    // 3. No job, no report — show default state
    analyticsContent.innerHTML = '<p class="no-data">No analytics run yet. Click "🧪 Run Analytics" to start.</p>';
    downloadPdfBtn.style.display = 'none';
    pipelineSteps.style.display = 'none';
}

// ═════════════════════════════════════════════════════════
// INITIALIZATION
// ═════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
    // Load saved environment
    const savedEnv = localStorage.getItem(ENV_KEY) || 'prod';
    applyEnvironment(savedEnv);

    // Check if user is already logged in
    const savedToken = localStorage.getItem(TOKEN_KEY);
    const savedUser = localStorage.getItem(USER_KEY);

    if (savedToken && savedUser) {
        currentToken = savedToken;
        currentUser = JSON.parse(savedUser);
        startRefreshTimer();
        showMainPanel();
    }

    // Character counters
    document.getElementById('surveyName').addEventListener('input', (e) => {
        document.getElementById('nameCount').textContent = `${e.target.value.length}/500`;
    });

    document.getElementById('surveyDescription').addEventListener('input', (e) => {
        document.getElementById('descCount').textContent = `${e.target.value.length}/2000`;
    });

    document.getElementById('surveyContext').addEventListener('input', (e) => {
        document.getElementById('contextCount').textContent = `${e.target.value.length}/50000`;
    });

    // Form submission
    document.getElementById('surveyForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        await generateSurvey();
    });
});

// ═════════════════════════════════════════════════════════
// AUTHENTICATION + NAVIGATION → see auth.js
// ═════════════════════════════════════════════════════════

function showSurveyForm() {
    // Hide all sections except survey form
    hideAllSections();
    const surveyFormSection = document.getElementById('surveyFormSection');
    const responseSection = document.getElementById('responseSection');
    const surveyForm = document.getElementById('surveyForm');

    if (surveyFormSection) surveyFormSection.style.display = 'block';
    if (responseSection) responseSection.style.display = 'none';
    if (surveyForm) surveyForm.style.display = 'block';

    setActiveTab('create');

    // Populate panel dropdown
    if (typeof loadPanelsForSurveyForm === 'function') loadPanelsForSurveyForm();

    // Reset attribute-targeting condition builder (values are stale per tenant)
    if (typeof resetAttributeConditions === 'function') resetAttributeConditions();

    // Scroll to top
    window.scrollTo(0, 0);
}

function showSurveysList() {
    // Hide all sections except surveys list
    hideAllSections();
    const surveysSection = document.getElementById('surveysSection');

    if (surveysSection) surveysSection.style.display = 'flex';

    setActiveTab('surveys');

    // Load surveys from API
    loadSurveysList();

    // Scroll to top
    window.scrollTo(0, 0);
}

// ═════════════════════════════════════════════════════════
// GLP-1 SURVEY CREATION
// ═════════════════════════════════════════════════════════

let glp1UploadedJson = null;

// Valid question types for the platform
const GLP1_VALID_QUESTION_TYPES = [
    'rating', 'mcq', 'image_selection', 'ranking', 'text', 'slider',
    'multi_slider', 'image_grid_slider',
    'rating_v2', 'consent', 'information_screen', 'height_weight',
];

function openGLP1SurveyModal() {
    const modal = document.getElementById('glp1SurveyModal');
    if (modal) {
        modal.style.display = 'flex';
        clearGLP1File();
    }
}

function closeGLP1SurveyModal() {
    const modal = document.getElementById('glp1SurveyModal');
    if (modal) {
        modal.style.display = 'none';
        clearGLP1File();
    }
}

/**
 * Validate the uploaded GLP-1 survey JSON structure.
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
function validateGLP1Json(json) {
    const errors = [];
    const warnings = [];

    // 1. Top-level required fields
    if (!json.title || typeof json.title !== 'string' || json.title.trim().length === 0) {
        errors.push('Missing or empty "title" field.');
    }
    if (!Array.isArray(json.questions)) {
        errors.push('Missing "questions" array.');
        return { valid: false, errors, warnings };
    }
    if (json.questions.length === 0) {
        errors.push('"questions" array is empty.');
        return { valid: false, errors, warnings };
    }

    // 2. Validate each question
    const seenIds = new Set();
    json.questions.forEach((q, idx) => {
        const loc = `Question ${idx + 1} (id: ${q.id || 'missing'})`;

        // Required fields
        if (!q.id) {
            errors.push(`${loc}: Missing "id" field.`);
        } else if (seenIds.has(q.id)) {
            errors.push(`${loc}: Duplicate question id "${q.id}".`);
        } else {
            seenIds.add(q.id);
        }

        if (!q.type) {
            errors.push(`${loc}: Missing "type" field.`);
        } else if (!GLP1_VALID_QUESTION_TYPES.includes(q.type)) {
            errors.push(`${loc}: Invalid question type "${q.type}". Valid types: ${GLP1_VALID_QUESTION_TYPES.join(', ')}`);
        }

        if (!q.title && q.type !== 'information_screen') {
            warnings.push(`${loc}: Missing "title" — question text will be empty.`);
        }

        // Type-specific data validation
        const data = q.data || {};
        switch (q.type) {
            case 'rating':
            case 'rating_v2':
                if (data.scale === undefined) {
                    warnings.push(`${loc}: Rating missing "scale" in data. Defaulting to 5.`);
                }
                break;
            case 'mcq':
                if (!Array.isArray(data.options) || data.options.length === 0) {
                    errors.push(`${loc}: MCQ has no "options" array in data.`);
                } else {
                    data.options.forEach((opt, oi) => {
                        if (!opt.label && !opt.text) {
                            warnings.push(`${loc}: Option ${oi + 1} has no "label" or "text".`);
                        }
                    });
                }
                break;
            case 'slider':
                if (!data.leftLabel && !data.rightLabel && !data.emojis) {
                    warnings.push(`${loc}: Slider missing label fields (leftLabel/rightLabel).`);
                }
                break;
            case 'multi_slider':
                if (!Array.isArray(data.sliders) || data.sliders.length === 0) {
                    errors.push(`${loc}: multi_slider has no "sliders" array in data.`);
                }
                break;
            case 'image_selection':
                if (!Array.isArray(data.images) || data.images.length === 0) {
                    errors.push(`${loc}: image_selection has no "images" array in data.`);
                }
                break;
            case 'ranking':
                if (!Array.isArray(data.items) || data.items.length === 0) {
                    errors.push(`${loc}: ranking has no "items" array in data.`);
                }
                break;
            case 'image_grid_slider':
                if (!Array.isArray(data.images) || data.images.length === 0) {
                    errors.push(`${loc}: image_grid_slider has no "images" array in data.`);
                }
                break;
            // consent, information_screen, height_weight, text — no strict data requirements
        }
    });

    // 3. Section checks (warnings only)
    const allIds = json.questions.map(q => (q.id || '').toLowerCase());
    const allSections = json.questions.map(q => (q.section || '').toLowerCase());
    const allTypes = json.questions.map(q => q.type || '');

    if (!allTypes.includes('consent') && !allIds.some(id => id.includes('consent'))) {
        warnings.push('No consent/screening question detected. Consider adding one.');
    }
    if (!allSections.some(s => s.includes('demograph')) && !allIds.some(id => ['gender', 'income', 'age', 'region'].some(k => id.includes(k)))) {
        warnings.push('No demographics section detected.');
    }
    if (!allSections.some(s => s.includes('medication')) && !allIds.some(id => id.includes('med_'))) {
        warnings.push('No medication history section detected.');
    }

    return { valid: errors.length === 0, errors, warnings };
}

function handleGLP1FileSelect(input) {
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const json = JSON.parse(e.target.result);

            // ── Run validation ──
            const { valid, errors, warnings } = validateGLP1Json(json);

            // Show errors / warnings
            const warningsArea = document.getElementById('glp1WarningsArea');
            const warningsList = document.getElementById('glp1WarningsList');

            if (errors.length > 0 || warnings.length > 0) {
                warningsArea.style.display = 'block';
                let html = '';
                if (errors.length > 0) {
                    html += '<li style="color:#c0392b; font-weight:600;">Errors (must fix):</li>';
                    html += errors.map(e => `<li style="color:#c0392b;">❌ ${escapeHTML(e)}</li>`).join('');
                }
                if (warnings.length > 0) {
                    html += '<li style="color:#8a6d3b; font-weight:600; margin-top:6px;">Warnings:</li>';
                    html += warnings.map(w => `<li>⚠️ ${escapeHTML(w)}</li>`).join('');
                }
                warningsList.innerHTML = html;
            } else {
                warningsArea.style.display = 'none';
            }

            if (!valid) {
                showToast(`JSON has ${errors.length} error(s) — fix before uploading`, 'error');
                // Show file info but keep button disabled
                document.getElementById('glp1DropContent').style.display = 'none';
                document.getElementById('glp1FileInfo').style.display = 'block';
                document.getElementById('glp1FileName').textContent = file.name;
                document.getElementById('glp1FileStats').textContent = `❌ ${errors.length} error(s) found`;
                document.getElementById('glp1FileStats').style.color = '#c0392b';
                document.getElementById('createGlp1Btn').disabled = true;
                glp1UploadedJson = null;
                return;
            }

            // Valid JSON — store and update UI
            glp1UploadedJson = json;
            
            document.getElementById('glp1DropContent').style.display = 'none';
            const fileInfo = document.getElementById('glp1FileInfo');
            fileInfo.style.display = 'block';
            document.getElementById('glp1FileName').textContent = file.name;
            
            const qCount = (json.questions || []).length;
            const statsEl = document.getElementById('glp1FileStats');
            statsEl.textContent = `✅ ${qCount} questions — valid`;
            statsEl.style.color = '#27ae60';

            // Detect Sections
            const sections = new Set();
            (json.questions || []).forEach(q => {
                if (q.section) sections.add(q.section);
            });
            
            const sectionsPreview = document.getElementById('glp1SectionsPreview');
            const sectionsList = document.getElementById('glp1SectionsList');
            if (sections.size > 0) {
                sectionsPreview.style.display = 'block';
                sectionsList.innerHTML = Array.from(sections)
                    .map(s => `<div style="padding: 4px 0; border-bottom: 1px solid #eee;">• ${escapeHTML(s)}</div>`)
                    .join('');
            } else {
                sectionsPreview.style.display = 'none';
            }

            document.getElementById('createGlp1Btn').disabled = false;
        } catch (err) {
            showToast('Invalid JSON file — could not parse', 'error');
            clearGLP1File();
        }
    };
    reader.readAsText(file);
}

function clearGLP1File() {
    glp1UploadedJson = null;
    const input = document.getElementById('glp1FileInput');
    if (input) input.value = '';
    
    document.getElementById('glp1DropContent').style.display = 'block';
    document.getElementById('glp1FileInfo').style.display = 'none';
    const statsEl = document.getElementById('glp1FileStats');
    if (statsEl) statsEl.style.color = '#666';
    document.getElementById('glp1SectionsPreview').style.display = 'none';
    document.getElementById('glp1WarningsArea').style.display = 'none';
    document.getElementById('createGlp1Btn').disabled = true;
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

async function submitGLP1SurveyCreation() {
    const titleInput = document.getElementById('glp1Title');
    const pointsInput = document.getElementById('glp1Points');
    const maxResponsesInput = document.getElementById('glp1MaxResponses');

    const title = titleInput ? titleInput.value.trim() : 'GLP-1 Phase 1 Consumer Research Survey';
    const points = parseInt(pointsInput ? pointsInput.value : '50') || 50;
    const maxResponses = parseInt(maxResponsesInput ? maxResponsesInput.value : '500') || 500;

    if (!title) {
        showToast('Please enter a survey title', 'error');
        return;
    }

    if (!glp1UploadedJson) {
        showToast('Please upload a JSON file first', 'error');
        return;
    }

    const btn = document.getElementById('createGlp1Btn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Creating Draft...';
    }

    try {
        const payload = {
            title,
            points,
            max_responses: maxResponses,
            auto_publish: false,
            survey_json: glp1UploadedJson,
        };

        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/create-glp1`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || 'Failed to create GLP-1 survey');
        }

        // Show server-side warnings if any
        if (data.warnings && data.warnings.length > 0) {
            const warningsArea = document.getElementById('glp1WarningsArea');
            const warningsList = document.getElementById('glp1WarningsList');
            warningsArea.style.display = 'block';
            warningsList.innerHTML = data.warnings.map(w => `<li>⚠️ ${escapeHTML(w)}</li>`).join('');
        }

        showToast(`✅ GLP-1 survey created as DRAFT with ${data.questions_count} questions. Review and publish from the surveys list.`, 'success');
        closeGLP1SurveyModal();
        showSurveysList();

    } catch (e) {
        console.error('Error creating GLP-1 survey:', e);
        showToast(e.message || 'Error creating GLP-1 survey', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '📄 Create as Draft';
        }
    }
}

// ═════════════════════════════════════════════════════════
// DASHBOARD
// ═════════════════════════════════════════════════════════

async function showDashboard() {
    hideAllSections();
    document.getElementById('dashboardSection').style.display = 'block';
    setActiveTab('dashboard');
    await loadDashboard();
}

async function loadDashboard() {
    const timeFilter = document.getElementById('timeFilter').value;

    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/admin/stats?time_filter=${timeFilter}`
        );

        if (response.status === 403) {
            showToast('Admin access required', 'error');
            logout();
            return;
        }

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        displayDashboard(data);
        loadAbandonment();

    } catch (error) {
        console.error('Dashboard error:', error);
        showToast(`Failed to load dashboard: ${error.message}`, 'error');
    }
}

function displayDashboard(data) {
    // Update content header subtitle with refresh timestamp
    const subtitleEl = document.getElementById('pageSubtitle');
    if (subtitleEl) {
        subtitleEl.textContent = `Last updated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
    }

    // User metrics
    document.getElementById('totalUsers').textContent = data.users.total.toLocaleString();
    document.getElementById('activeUsers').textContent = data.users.active.toLocaleString();
    document.getElementById('newSignups').textContent = data.users.new_signups.toLocaleString();
    document.getElementById('userGrowth').textContent = `${data.users.growth_rate >= 0 ? '+' : ''}${data.users.growth_rate.toFixed(1)}%`;

    // Survey metrics
    document.getElementById('totalSurveys').textContent = data.surveys.total;
    document.getElementById('publishedSurveys').textContent = data.surveys.published;
    document.getElementById('completedSurveys').textContent = data.surveys.completed.toLocaleString();
    document.getElementById('incompleteSurveys').textContent = data.surveys.incomplete.toLocaleString();
    document.getElementById('completionRate').textContent = `${data.surveys.completion_rate.toFixed(1)}%`;

    // Reward metrics
    document.getElementById('pointsCirculation').textContent = data.rewards.points_in_circulation.toLocaleString();
    document.getElementById('totalEarned').textContent = data.rewards.total_earned.toLocaleString();
    document.getElementById('totalRedeemed').textContent = data.rewards.total_redeemed.toLocaleString();
    document.getElementById('redemptionRate').textContent = `${data.rewards.redemption_rate.toFixed(1)}%`;

    // Voucher metrics
    document.getElementById('voucherCount').textContent = data.vouchers.redemptions_count.toLocaleString();
    document.getElementById('voucherValue').textContent = `$${data.vouchers.redemptions_value_usd.toFixed(2)}`;

    const brandsHTML = data.vouchers.top_brands.map(b =>
        `<li>${b.brand}: ${b.redemption_count} ($${b.total_value_usd.toFixed(2)})</li>`
    ).join('');
    document.getElementById('topBrands').innerHTML = brandsHTML || '<li>No data</li>';

    // Referral metrics
    document.getElementById('referralSignups').textContent = data.referrals.total_signups.toLocaleString();
    document.getElementById('newReferrals').textContent = data.referrals.new_signups.toLocaleString();
    document.getElementById('referralConversion').textContent = `${data.referrals.conversion_rate.toFixed(1)}%`;

    // Withdrawal progress metrics
    document.getElementById('eligibleForWithdrawal').textContent = data.withdrawal_progress.eligible_now.toLocaleString();
    document.getElementById('closeToWithdrawal').textContent = data.withdrawal_progress.close.toLocaleString();
    document.getElementById('halfwayToWithdrawal').textContent = data.withdrawal_progress.halfway.toLocaleString();
    document.getElementById('withdrawalTotalUsers').textContent = data.users.total.toLocaleString();

    // Cache info
    if (data.cache_info) {
        document.getElementById('cacheAge').textContent = `${data.cache_info.age_minutes.toFixed(1)} min ago`;
        document.getElementById('cacheExpires').textContent = `${data.cache_info.expires_in_minutes.toFixed(1)} min`;
    }
}

// ═════════════════════════════════════════════════════════
// DROP-OFF / ABANDONMENT ANALYTICS
// ═════════════════════════════════════════════════════════

let abandonmentSelectedSurveyId = null;
let abandonmentFunnelChart = null;

function abandonEscape(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function abandonStaleHours() {
    const el = document.getElementById('abandonmentStaleHours');
    return el ? el.value : '24';
}

async function loadAbandonment() {
    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/admin/abandonment/summary?stale_hours=${abandonStaleHours()}`
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderAbandonmentLeaderboard(data.surveys || []);
        // Keep an open detail in sync with the stale-hours selection
        if (abandonmentSelectedSurveyId) {
            loadSurveyAbandonment(abandonmentSelectedSurveyId);
        }
    } catch (error) {
        console.error('Abandonment error:', error);
        const tbody = document.querySelector('#abandonmentLeaderboard tbody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="6" class="abandon-empty">Failed to load: ${abandonEscape(error.message)}</td></tr>`;
        }
    }
}

function renderAbandonmentLeaderboard(surveys) {
    const tbody = document.querySelector('#abandonmentLeaderboard tbody');
    if (!tbody) return;
    if (!surveys.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="abandon-empty">No standard-survey sessions yet.</td></tr>';
        return;
    }
    tbody.innerHTML = surveys.map(s => {
        const pct = s.completion_rate_pct ?? 0;
        const rateClass = pct >= 70 ? 'abandon-good' : pct >= 40 ? 'abandon-warn' : 'abandon-bad';
        return `<tr class="abandon-row" data-survey-id="${s.survey_id}" onclick="loadSurveyAbandonment('${s.survey_id}')">
            <td>${abandonEscape(s.title)}</td>
            <td>${s.started}</td>
            <td>${s.completed}</td>
            <td class="abandon-bad-text">${s.abandoned}</td>
            <td>${s.active}</td>
            <td><span class="abandon-pill ${rateClass}">${pct.toFixed(1)}%</span></td>
        </tr>`;
    }).join('');
    updateAbandonHighlight();
}

function updateAbandonHighlight() {
    document.querySelectorAll('#abandonmentLeaderboard tbody tr[data-survey-id]').forEach(tr => {
        tr.classList.toggle('abandon-row-active', tr.dataset.surveyId === abandonmentSelectedSurveyId);
    });
}

async function loadSurveyAbandonment(surveyId) {
    abandonmentSelectedSurveyId = surveyId;
    updateAbandonHighlight();
    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/admin/surveys/${surveyId}/abandonment?stale_hours=${abandonStaleHours()}`
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        renderSurveyAbandonment(data);
    } catch (error) {
        console.error('Survey abandonment error:', error);
        showToast(`Failed to load drop-off detail: ${error.message}`, 'error');
    }
}

function renderSurveyAbandonment(d) {
    const detail = document.getElementById('abandonmentDetail');
    if (detail) detail.style.display = 'block';

    const titleEl = document.getElementById('abandonmentDetailTitle');
    if (titleEl) titleEl.textContent = `Drop-off — ${d.title || 'survey'}`;

    const kpis = document.getElementById('abandonmentKpis');
    if (kpis) {
        kpis.innerHTML =
            abandonKpi(d.started, 'Started') +
            abandonKpi(d.completed, 'Completed') +
            abandonKpi(d.abandoned, 'Abandoned') +
            abandonKpi(d.active, 'Active') +
            abandonKpi(`${(d.completion_rate_pct ?? 0).toFixed(1)}%`, 'Completion');
    }

    renderAbandonmentFunnel(d.funnel || []);
    renderAbandonmentFriction(d.friction || []);
}

function abandonKpi(value, label) {
    return `<div class="kpi-card"><div class="kpi-value">${value}</div><div class="kpi-label">${label}</div></div>`;
}

function abandonBarColor(rate) {
    // 0% abandon -> brand purple (#534AB7); >=50% -> error red (#E24B4A)
    const t = Math.max(0, Math.min(1, (rate || 0) / 50));
    const brand = [83, 74, 183];
    const error = [226, 75, 74];
    const mix = brand.map((b, i) => Math.round(b + (error[i] - b) * t));
    return `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`;
}

function renderAbandonmentFunnel(funnel) {
    const canvas = document.getElementById('abandonmentFunnelChart');
    if (!canvas || typeof Chart === 'undefined') return;

    if (abandonmentFunnelChart) {
        abandonmentFunnelChart.destroy();
        abandonmentFunnelChart = null;
    }
    if (!funnel.length) return;

    // Size the chart area to the question count for readability
    if (canvas.parentElement) {
        canvas.parentElement.style.height = `${Math.max(160, funnel.length * 34 + 40)}px`;
    }

    abandonmentFunnelChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: funnel.map(f => `Q${f.ordinal + 1}`),
            datasets: [{
                label: 'Reached',
                data: funnel.map(f => f.reached),
                backgroundColor: funnel.map(f => abandonBarColor(f.abandon_rate_pct)),
                borderWidth: 0,
                borderRadius: 4,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => {
                            const f = funnel[items[0].dataIndex];
                            return `Q${f.ordinal + 1}. ${f.title || ''}`;
                        },
                        label: (item) => {
                            const f = funnel[item.dataIndex];
                            return [
                                `Reached: ${f.reached}`,
                                `Abandoned here: ${f.abandoned_here} (${(f.abandon_rate_pct ?? 0).toFixed(1)}%)`,
                            ];
                        },
                    },
                },
            },
            scales: {
                x: { beginAtZero: true, ticks: { precision: 0 }, grid: { color: 'rgba(0,0,0,0.05)' } },
                y: { grid: { display: false } },
            },
        },
    });
}

function renderAbandonmentFriction(friction) {
    const tbody = document.querySelector('#abandonmentFriction tbody');
    if (!tbody) return;
    if (!friction.length) {
        tbody.innerHTML = '<tr><td colspan="7" class="abandon-empty">No published version / no responses.</td></tr>';
        return;
    }
    const ms = (v) => (v == null ? '—' : `${Math.round(v).toLocaleString()} ms`);
    const num = (v) => (v == null ? '—' : Number(v).toFixed(2));
    tbody.innerHTML = friction.map(r => `
        <tr>
            <td>Q${r.ordinal + 1}</td>
            <td>${abandonEscape(r.title)}</td>
            <td>${abandonEscape(r.type)}</td>
            <td>${r.answer_count}</td>
            <td>${ms(r.median_time_spent_ms)}</td>
            <td>${num(r.avg_option_change_count)}</td>
            <td>${ms(r.median_decision_latency_ms)}</td>
        </tr>`).join('');
}

async function refreshDashboard() {
    const timeFilter = document.getElementById('timeFilter').value;

    try {
        showToast('Refreshing stats...', 'info');

        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/admin/stats/refresh?time_filter=${timeFilter}`,
            { method: 'POST' }
        );

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        displayDashboard(data);
        showToast('✅ Stats refreshed!', 'success');

    } catch (error) {
        console.error('Refresh error:', error);
        showToast(`Refresh failed: ${error.message}`, 'error');
    }
}

function hideAllSections() {
    document.getElementById('dashboardSection').style.display = 'none';
    document.getElementById('surveyFormSection').style.display = 'none';
    document.getElementById('surveysSection').style.display = 'none';
    document.getElementById('notificationsSection').style.display = 'none';
    document.getElementById('surveyDetailsSection').style.display = 'none';
    document.getElementById('backfillDemographicsSection').style.display = 'none';
    document.getElementById('backfillMetricsSection').style.display = 'none';
    document.getElementById('emailBroadcastSection').style.display = 'none';
    document.getElementById('panelsSection').style.display = 'none';
    const rd = document.getElementById('redemptionsSection');
    if (rd) rd.style.display = 'none';
    const pq = document.getElementById('profileQuestionnairesSection');
    if (pq) pq.style.display = 'none';
    const vs = document.getElementById('validatorSection');
    if (vs) vs.style.display = 'none';
    const uq = document.getElementById('userQualitySection');
    if (uq) uq.style.display = 'none';
    const pa = document.getElementById('profileAttributesSection');
    if (pa) pa.style.display = 'none';
}

function setActiveTab(section) {
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.classList.toggle('active', item.dataset.section === section);
    });

    const titles = {
        dashboard: 'Dashboard',
        surveys: 'Surveys',
        create: 'Create survey',
        notifications: 'Notifications',
        email: 'Email broadcast',
        panels: 'Panels',
        'profile-questionnaires': 'Profile questionnaires',
        'profile-attributes': 'Profile attributes',
        'backfill-demographics': 'Backfill demographics',
        'backfill-metrics': 'Backfill metrics',
        validator: 'Survey validator',
        redemptions: 'Redemptions',
        'user-quality': 'User quality',
    };

    const titleEl = document.getElementById('pageTitle');
    if (titleEl && titles[section]) titleEl.textContent = titles[section];

    // Only show subtitle on dashboard
    const subtitleEl = document.getElementById('pageSubtitle');
    if (subtitleEl) subtitleEl.style.display = section === 'dashboard' ? '' : 'none';
}

async function loadSurveysList() {
    const tableBody = document.getElementById('surveysTableBody');

    if (!tableBody) {
        console.error('surveys table body not found');
        return;
    }

    try {
        // Use admin endpoint to get ALL surveys (not filtered by user/active)
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/surveys`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (response.status === 403) {
            showToast('Admin access required to view surveys', 'error');
            throw new Error('Admin access required (403 Forbidden)');
        }

        if (!response.ok) {
            let detail = `HTTP ${response.status}`;
            try {
                const errData = await response.json();
                detail = errData.detail || detail;
            } catch (e) {}
            throw new Error(detail);
        }

        const surveys = await response.json();

        if (!surveys || surveys.length === 0) {
            allSurveys = [];
            renderSurveysTable([]);
            return;
        }

        // Store surveys for client-side filtering
        allSurveys = surveys;

        // Render table with all surveys (unfiltered)
        renderSurveysTable(surveys);

        // Update count display
        updateSurveysCount();

        // Wire up filter event listeners (only once per load)
        wireUpSurveyFilters();

        console.log(`✅ Loaded ${surveys.length} survey(s)`);
    } catch (error) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="6" style="text-align: center; padding: 20px; color: var(--color-error);">
                    Error loading surveys: ${error.message}
                </td>
            </tr>
        `;
        console.error('Error loading surveys:', error);
    }
}

function renderSurveysTable(surveys) {
    const tableBody = document.getElementById('surveysTableBody');
    const noSurveysMessage = document.getElementById('noSurveysMessage');

    if (!tableBody) return;

    if (!surveys || surveys.length === 0) {
        tableBody.innerHTML = '';
        if (noSurveysMessage) noSurveysMessage.style.display = 'block';
        return;
    }

    if (noSurveysMessage) noSurveysMessage.style.display = 'none';

    // Populate table with surveys
    tableBody.innerHTML = surveys.map(survey => `
        <tr>
            <td><strong>${survey.title || 'Untitled'}</strong></td>
            <td>${survey.questions_count || 0}</td>
            <td>
                <span class="status-${survey.is_active ? 'active' : 'draft'}">
                    ${survey.is_active ? '✓ Published' : '⏱ Draft'}
                </span>
            </td>
            <td>${survey.completed_count || 0} / ${survey.max_responses || 100}</td>
            <td>${new Date(survey.created_at).toLocaleDateString()}</td>
            <td style="display: flex; gap: 4px;">
                <button class="btn-ghost" onclick="viewSurvey('${survey.id}')">View</button>
                ${!survey.is_active ? `<button class="btn-ghost btn-ghost-brand" onclick="publishSurveyDirect('${survey.id}')">Publish</button>` : ''}
                ${survey.is_active && (survey.completed_count || 0) < (survey.max_responses || 100)
                    ? `<button class="btn-ghost" onclick="notifyRemainingParticipants('${survey.id}')">🔔 Notify remaining</button>`
                    : ''}
            </td>
        </tr>
    `).join('');
}

function updateSurveysCount() {
    const countDisplay = document.getElementById('surveysCountDisplay');
    if (countDisplay) {
        countDisplay.textContent = allSurveys.length;
    }
}

function filterSurveys() {
    const q = document.getElementById('surveysSearch').value.toLowerCase().trim();
    const status = document.getElementById('surveysStatusFilter').value;

    const filtered = allSurveys.filter(s => {
        const matchTitle = !q || (s.title || '').toLowerCase().includes(q);
        const matchStatus = !status
            || (status === 'published' && s.is_active)
            || (status === 'draft' && !s.is_active);
        return matchTitle && matchStatus;
    });

    renderSurveysTable(filtered);

    // Show/hide clear button
    const clearBtn = document.getElementById('surveysClearFilters');
    if (clearBtn) {
        clearBtn.style.display = (q || status) ? 'inline-flex' : 'none';
    }
}

let filterDebounceTimer = null;

function wireUpSurveyFilters() {
    const searchInput = document.getElementById('surveysSearch');
    const statusFilter = document.getElementById('surveysStatusFilter');
    const clearBtn = document.getElementById('surveysClearFilters');

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            clearTimeout(filterDebounceTimer);
            filterDebounceTimer = setTimeout(() => {
                filterSurveys();
            }, 200);
        });
    }

    if (statusFilter) {
        statusFilter.addEventListener('change', () => {
            filterSurveys();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (searchInput) searchInput.value = '';
            if (statusFilter) statusFilter.value = '';
            filterSurveys();
        });
    }
}

async function viewSurvey(surveyId) {
    try {
        // Fetch survey details using the regular endpoint
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            throw new Error('Failed to load survey details');
        }

        const surveyData = await response.json();
        currentSurveyData = surveyData;

        // Navigate to details view
        showSurveyDetails(surveyData);

        // Load metrics in background
        loadSurveyMetrics(surveyId);
    } catch (error) {
        showToast(`Error loading survey: ${error.message}`, 'error');
        console.error('Error:', error);
    }
}

async function publishSurveyDirect(surveyId) {
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to publish survey');
        }

        const data = await response.json();
        showToast(`✅ ${data.message}`, 'success');

        // Reload surveys list
        loadSurveysList();
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Publish error:', error);
    }
}

async function notifyRemainingParticipants(surveyId) {
    if (!confirm('Notify all remaining eligible participants who haven\'t taken this survey yet?')) return;

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/surveys/${surveyId}/notify-remaining`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.detail || 'Failed to notify remaining participants');
        }

        const data = await response.json();
        showToast(`✅ ${data.message}`, 'success');
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Notify remaining error:', error);
    }
}

async function loadTenants() {
    const tenantSelect = document.getElementById('tenantId');

    try {
        // Fetch real tenants from API
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/auth/tenants`, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            console.warn('Failed to fetch tenants from API, using fallback');
            loadMockTenants();
            return;
        }

        const data = await response.json();
        const tenants = data.tenants || data || [];

        if (tenants.length === 0) {
            console.warn('No tenants found in API response, using fallback');
            loadMockTenants();
            return;
        }

        // Clear existing options
        tenantSelect.innerHTML = '<option value="">Select Organization</option>';

        // Add real tenants
        tenants.forEach(tenant => {
            const option = document.createElement('option');
            option.value = tenant.id;
            option.textContent = tenant.name || `Tenant ${tenant.id.substring(0, 8)}`;
            tenantSelect.appendChild(option);
        });

        // Set first tenant as default
        if (tenants.length > 0) {
            tenantSelect.value = tenants[0].id;
            localStorage.setItem(TENANT_ID_KEY, tenants[0].id);
        }

        console.log(`✅ Loaded ${tenants.length} tenants from API`);
    } catch (error) {
        console.error('Error loading tenants:', error);
        loadMockTenants();
    }
}

function loadMockTenants() {
    // Fallback mock tenants if API fails
    const tenantSelect = document.getElementById('tenantId');
    const mockTenants = [
        { id: '00000000-0000-0000-0000-000000000001', name: 'Test Company' },
        { id: '00000000-0000-0000-0000-000000000002', name: 'Another Corp' }
    ];

    console.warn('⚠️ Using mock tenants - API call failed or returned no data');

    mockTenants.forEach(tenant => {
        const option = document.createElement('option');
        option.value = tenant.id;
        option.textContent = tenant.name;
        tenantSelect.appendChild(option);
    });

    // Set first tenant as default
    if (mockTenants.length > 0) {
        tenantSelect.value = mockTenants[0].id;
    }
}

function showToast(message, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast show ${type}`;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Environment switcher → see auth.js

// ═════════════════════════════════════════════════════════
// REFRESH TOKEN HANDLING
// ═════════════════════════════════════════════════════════

function startRefreshTimer() {
    stopRefreshTimer();
    // Refresh token every 25 minutes (access tokens typically expire at 30 min)
    refreshTimer = setTimeout(refreshAccessToken, 25 * 60 * 1000);
}

function stopRefreshTimer() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
}

async function refreshAccessToken() {
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    if (!refreshToken) {
        console.warn('No refresh token available');
        return false;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/auth/refresh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: refreshToken })
        });

        if (!response.ok) {
            console.error('Token refresh failed, logging out');
            logout();
            return false;
        }

        const data = await response.json();
        currentToken = data.access_token;
        localStorage.setItem(TOKEN_KEY, currentToken);

        if (data.refresh_token) {
            localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
        }

        startRefreshTimer();
        console.log('Token refreshed successfully');
        return true;
    } catch (error) {
        console.error('Token refresh error:', error);
        logout();
        return false;
    }
}

async function fetchWithAuth(url, options = {}) {
    // Add auth header
    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${currentToken}`;

    let response = await fetch(url, options);

    // If 401, attempt token refresh and retry once
    if (response.status === 401) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
            options.headers['Authorization'] = `Bearer ${currentToken}`;
            response = await fetch(url, options);
        }
    }

    return response;
}

// ═════════════════════════════════════════════════════════
// CUSTOM QUESTIONS UPLOAD HANDLERS
// ═════════════════════════════════════════════════════════

let uploadedCustomQuestionsPayload = null;

function handleCustomQuestionsUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parsed = JSON.parse(e.target.result);
            let categories = [];
            if (parsed.categories && Array.isArray(parsed.categories)) {
                categories = parsed.categories;
            } else if (Array.isArray(parsed)) {
                categories = [{ name: "General Custom Questions", questions: parsed }];
            } else if (parsed.questions && Array.isArray(parsed.questions)) {
                categories = [{ name: "General Custom Questions", questions: parsed.questions }];
            } else {
                throw new Error('JSON format invalid. Expected { "categories": [ { "name": "...", "questions": [...] } ] }');
            }

            let totalQuestions = 0;
            const validCategories = categories.map((cat, cIdx) => {
                const catName = cat.name || `Category ${cIdx + 1}`;
                const questions = (cat.questions || []).map((q, qIdx) => {
                    if (!q.title || !q.type) {
                        throw new Error(`Question ${qIdx + 1} in category "${catName}" missing title or type.`);
                    }
                    totalQuestions++;
                    return {
                        id: q.id || `cq_${cIdx + 1}_${qIdx + 1}`,
                        type: q.type,
                        title: q.title,
                        description: q.description || null,
                        required: q.required !== false,
                        data: q.data || {}
                    };
                });
                return { name: catName, questions };
            });

            if (totalQuestions === 0) {
                throw new Error('JSON file contains no custom questions.');
            }

            uploadedCustomQuestionsPayload = { categories: validCategories };
            document.getElementById('customQuestionsFileName').textContent = `${file.name} (${totalQuestions} question${totalQuestions > 1 ? 's' : ''})`;
            document.getElementById('clearCustomQuestionsBtn').style.display = 'inline-block';
            renderCustomQuestionsPreview(validCategories);
            showToast(`Loaded ${totalQuestions} custom question(s) successfully!`, 'success');
        } catch (err) {
            clearCustomQuestionsUpload();
            showToast(`Invalid custom questions file: ${err.message}`, 'error');
        }
    };
    reader.readAsText(file);
}

function clearCustomQuestionsUpload() {
    uploadedCustomQuestionsPayload = null;
    document.getElementById('customQuestionsFile').value = '';
    document.getElementById('customQuestionsFileName').textContent = 'No file selected';
    document.getElementById('clearCustomQuestionsBtn').style.display = 'none';
    document.getElementById('customQuestionsPreview').style.display = 'none';
    document.getElementById('customQuestionsCategoriesList').innerHTML = '';
}

function renderCustomQuestionsPreview(categories) {
    const previewEl = document.getElementById('customQuestionsPreview');
    const container = document.getElementById('customQuestionsCategoriesList');
    container.innerHTML = '';

    categories.forEach(cat => {
        const catDiv = document.createElement('div');
        catDiv.style.marginBottom = '8px';
        catDiv.innerHTML = `
            <div style="font-weight: 600; font-size: 13px; color: var(--color-accent, #6366f1); margin-bottom: 4px;">
                📁 ${cat.name} (${cat.questions.length})
            </div>
            <ul style="margin: 0; padding-left: 20px; font-size: 12px; color: var(--color-text-secondary);">
                ${cat.questions.map(q => `<li><strong>[${q.type}]</strong> ${q.title}</li>`).join('')}
            </ul>
        `;
        container.appendChild(catDiv);
    });

    previewEl.style.display = 'block';
}

// ═════════════════════════════════════════════════════════
// SURVEY GENERATION
// ═════════════════════════════════════════════════════════

async function generateSurvey() {
    const name = document.getElementById('surveyName').value;
    const description = document.getElementById('surveyDescription').value;
    const context = document.getElementById('surveyContext').value;
    const points = parseInt(document.getElementById('surveyPoints').value);
    const maxResponses = parseInt(document.getElementById('maxResponses').value) || 100;
    const tenantId = document.getElementById('tenantId').value;
    const surveyType = document.getElementById('surveyType').value;
    const isMultiConcept = document.querySelector('input[name="conceptType"]:checked').value === 'multi';
    const panelId = document.getElementById('surveyPanel').value || null;
    const aiProvider = document.getElementById('aiProvider').value || null;
    const targetAttributes = getTargetAttributesFromForm();

    if (!name || !description || !context || !tenantId || !surveyType) {
        showToast('Please fill in all required fields', 'error');
        return;
    }

    // Show loading spinner
    document.getElementById('loadingSpinner').style.display = 'block';
    document.getElementById('responseSection').style.display = 'none';
    document.getElementById('surveyForm').style.display = 'none';

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/generate-ai`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name,
                description,
                context,
                points,
                max_responses: maxResponses,
                tenant_id: tenantId,
                test_type: surveyType,
                is_multi_concept: isMultiConcept,
                concepts: getConceptsFromForm(),  // ss: send concepts with image URLs
                panel_id: panelId,
                ai_provider: aiProvider,
                target_attributes: targetAttributes,
                custom_questions: uploadedCustomQuestionsPayload
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to generate survey');
        }

        const data = await response.json();

        // Display response
        displaySurveyResponse(data);
        showToast('Survey generated successfully!', 'success');
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Generation error:', error);
    } finally {
        document.getElementById('loadingSpinner').style.display = 'none';
    }
}

// ═════════════════════════════════════════════════════════
// SURVEY STRUCTURE VALIDATOR (client-side, read-only)
// ═════════════════════════════════════════════════════════

function validateSurveyStructure(structure) {
    const errors = [];
    const warnings = [];

    if (!structure || typeof structure !== 'object') {
        errors.push({ code: 'no_structure', message: 'No survey structure provided.', location: null });
        return { errors, warnings };
    }

    const questions = structure.questions;
    if (!Array.isArray(questions) || questions.length === 0) {
        errors.push({ code: 'no_questions', message: 'Survey has no questions.', location: null });
        return { errors, warnings };
    }

    const locOf = (q, idx) => {
        const title = q && q.title ? ` — "${truncateText(q.title, 60)}"` : '';
        return `Q${idx + 1}${title}`;
    };

    // 1. Per-question required fields
    questions.forEach((q, idx) => {
        const loc = locOf(q, idx);
        if (!q || typeof q !== 'object') {
            errors.push({ code: 'invalid_question', message: 'Question entry is not an object.', location: `Q${idx + 1}` });
            return;
        }
        if (!q.id || typeof q.id !== 'string') {
            errors.push({ code: 'missing_id', message: 'Missing required "id" field.', location: loc });
        }
        if (!q.type) {
            errors.push({ code: 'missing_type', message: 'Missing required "type" field.', location: loc });
        }
        if (!q.title) {
            warnings.push({ code: 'missing_title', message: 'Question has no "title".', location: loc });
        }
        if (q.order === undefined || q.order === null) {
            warnings.push({ code: 'missing_order', message: 'Question has no "order" field.', location: loc });
        }
    });

    // 2. Duplicate question.id — the bug that caused the incident
    const idGroups = {};
    questions.forEach((q, idx) => {
        if (q && q.id) {
            if (!idGroups[q.id]) idGroups[q.id] = [];
            idGroups[q.id].push({ idx, title: q.title });
        }
    });
    Object.entries(idGroups).forEach(([id, group]) => {
        if (group.length > 1) {
            const list = group
                .map(g => `Q${g.idx + 1}${g.title ? ` ("${truncateText(g.title, 40)}")` : ''}`)
                .join(', ');
            errors.push({
                code: 'duplicate_question_id',
                message: `${group.length} questions share id "${id}" — only the first answer per session will be saved; the rest will be silently dropped. Affected: ${list}.`,
                location: null,
            });
        }
    });

    // 3. Duplicate option.id within a question
    questions.forEach((q, idx) => {
        const loc = locOf(q, idx);
        const options = q && q.data && q.data.options;
        if (Array.isArray(options)) {
            const seen = {};
            options.forEach(o => {
                if (o && o.id) seen[o.id] = (seen[o.id] || 0) + 1;
            });
            Object.entries(seen).forEach(([oid, count]) => {
                if (count > 1) {
                    errors.push({
                        code: 'duplicate_option_id',
                        message: `Option id "${oid}" appears ${count} times.`,
                        location: loc,
                    });
                }
            });
        }
    });

    // 4. Duplicate slider.id within a question
    questions.forEach((q, idx) => {
        const loc = locOf(q, idx);
        const sliders = q && q.data && q.data.sliders;
        if (Array.isArray(sliders)) {
            const seen = {};
            sliders.forEach(s => {
                if (s && s.id) seen[s.id] = (seen[s.id] || 0) + 1;
            });
            Object.entries(seen).forEach(([sid, count]) => {
                if (count > 1) {
                    errors.push({
                        code: 'duplicate_slider_id',
                        message: `Slider id "${sid}" appears ${count} times.`,
                        location: loc,
                    });
                }
            });
        }
    });

    // 5. Type/data shape mismatch (warnings)
    questions.forEach((q, idx) => {
        if (!q || !q.type) return;
        const loc = locOf(q, idx);
        const data = q.data || {};
        switch (q.type) {
            case 'text':
                if (data.options || data.sliders) {
                    warnings.push({ code: 'shape_mismatch', message: 'Text question has unexpected "options"/"sliders" in data.', location: loc });
                }
                if (data.min_length === undefined && data.max_length === undefined) {
                    warnings.push({ code: 'text_missing_length', message: 'Text question has no min_length/max_length.', location: loc });
                }
                break;
            case 'mcq':
                if (!Array.isArray(data.options) || data.options.length === 0) {
                    warnings.push({ code: 'mcq_missing_options', message: 'MCQ has no options array.', location: loc });
                }
                break;
            case 'multi_slider':
                if (!Array.isArray(data.sliders) || data.sliders.length === 0) {
                    warnings.push({ code: 'multi_slider_missing_sliders', message: 'multi_slider has no sliders array.', location: loc });
                }
                break;
            case 'rating':
                if (data.scale === undefined) {
                    warnings.push({ code: 'rating_missing_scale', message: 'Rating question has no "scale".', location: loc });
                }
                break;
            case 'ranking':
                if (!Array.isArray(data.items) || data.items.length === 0) {
                    warnings.push({ code: 'ranking_missing_items', message: 'Ranking question has no items array.', location: loc });
                }
                break;
            case 'slider':
                // single slider — no required nested array
                break;
            case 'image_selection':
                if (!Array.isArray(data.images) || data.images.length === 0) {
                    warnings.push({ code: 'image_selection_missing_images', message: 'image_selection has no images array.', location: loc });
                }
                break;
            case 'image_grid_slider':
                if (!Array.isArray(data.images) || data.images.length === 0) {
                    warnings.push({ code: 'image_grid_slider_missing_images', message: 'image_grid_slider has no images array.', location: loc });
                }
                break;
        }
    });

    // 6. Duplicate `order` values
    const orderSeen = {};
    questions.forEach(q => {
        if (q && q.order !== undefined && q.order !== null) {
            orderSeen[q.order] = (orderSeen[q.order] || 0) + 1;
        }
    });
    Object.entries(orderSeen).forEach(([ord, count]) => {
        if (count > 1) {
            warnings.push({
                code: 'duplicate_order',
                message: `${count} questions share order value "${ord}".`,
                location: null,
            });
        }
    });

    return { errors, warnings };
}

function truncateText(s, max) {
    if (!s) return '';
    const str = String(s);
    return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function escapeValidationHTML(str) {
    return String(str).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

// Standalone validator page — paste any survey JSON and check it
function showValidatorPage() {
    hideAllSections();
    const section = document.getElementById('validatorSection');
    if (section) section.style.display = 'block';
    setActiveTab('validator');
    window.scrollTo(0, 0);
}

function runStandaloneValidation() {
    const input = document.getElementById('validatorJsonInput');
    const banner = document.getElementById('validatorBanner');
    if (!input || !banner) return;

    const raw = input.value.trim();
    if (!raw) {
        banner.innerHTML = '<div class="validation-banner-header">⚠️ Paste a survey JSON above first.</div>';
        banner.className = 'validation-banner warning';
        banner.style.display = 'block';
        return;
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        banner.innerHTML =
            '<div class="validation-banner-header">❌ Invalid JSON</div>' +
            '<ul class="validation-banner-list"><li>' + escapeValidationHTML(err.message) + '</li></ul>';
        banner.className = 'validation-banner error';
        banner.style.display = 'block';
        return;
    }

    // Accept either a raw structure or a wrapper like {structure: {...}} or {current_version:{structure:{...}}}
    let structure = parsed;
    if (parsed && parsed.structure && typeof parsed.structure === 'object') {
        structure = parsed.structure;
    } else if (parsed && parsed.current_version && parsed.current_version.structure) {
        structure = parsed.current_version.structure;
    }

    renderValidationBanner('validatorBanner', structure);
}

function clearValidatorInput() {
    const input = document.getElementById('validatorJsonInput');
    const banner = document.getElementById('validatorBanner');
    if (input) input.value = '';
    if (banner) {
        banner.innerHTML = '';
        banner.style.display = 'none';
    }
}

function loadValidatorSample() {
    const sample = {
        test_type: 'concept_test',
        title: 'Sample buggy survey (duplicate q_general)',
        description: 'Five questions share id "q_general" — only the first answer per session would save.',
        questions: [
            { id: 'q_general', order: 1, type: 'mcq', title: 'Which fast-food restaurant do you visit most often?', required: true, data: { options: [{ id: 'mcdonalds', text: "McDonald's" }, { id: 'starbucks', text: 'Starbucks' }], allow_multiple: false } },
            { id: 'q_general', order: 2, type: 'mcq', title: 'What beverage are you most likely to order?', required: true, data: { options: [{ id: 'iced_coffee', text: 'Iced Coffee' }, { id: 'tea', text: 'Tea' }], allow_multiple: false } },
            { id: 'q_appeal', order: 3, type: 'multi_slider', title: 'How appealing does each concept sound?', required: true, data: { sliders: [{ id: 'a', description: 'Concept A' }, { id: 'b', description: 'Concept B' }], emojis: { left: '😐', right: '🤩' } } },
            { id: 'q_general', order: 4, type: 'mcq', title: 'Which one would you most want to try?', required: true, data: { options: [{ id: 'a', text: 'Concept A' }], allow_multiple: false } },
            { id: 'q_general', order: 5, type: 'text', title: 'What makes your top choice stand out?', required: false, data: { min_length: 10, max_length: 300 } }
        ]
    };
    const input = document.getElementById('validatorJsonInput');
    if (input) input.value = JSON.stringify(sample, null, 2);
    runStandaloneValidation();
}

function renderValidationBanner(bannerId, structure) {
    const banner = document.getElementById(bannerId);
    if (!banner) return;

    const { errors, warnings } = validateSurveyStructure(structure);

    const renderList = (items) => items
        .map(it => `<li>${it.location ? `<strong>${escapeValidationHTML(it.location)}:</strong> ` : ''}${escapeValidationHTML(it.message)}</li>`)
        .join('');

    if (errors.length > 0) {
        let html = `<div class="validation-banner-header">❌ Survey has ${errors.length} issue${errors.length !== 1 ? 's' : ''} that will cause data loss:</div>`;
        html += `<ul class="validation-banner-list">${renderList(errors)}</ul>`;
        if (warnings.length > 0) {
            html += `<div class="validation-banner-subhead">Plus ${warnings.length} non-critical warning${warnings.length !== 1 ? 's' : ''}:</div>`;
            html += `<ul class="validation-banner-list">${renderList(warnings)}</ul>`;
        }
        banner.innerHTML = html;
        banner.className = 'validation-banner error';
        banner.style.display = 'block';
    } else if (warnings.length > 0) {
        let html = `<div class="validation-banner-header">⚠️ Heads up — ${warnings.length} issue${warnings.length !== 1 ? 's' : ''} to review:</div>`;
        html += `<ul class="validation-banner-list">${renderList(warnings)}</ul>`;
        banner.innerHTML = html;
        banner.className = 'validation-banner warning';
        banner.style.display = 'block';
    } else {
        banner.innerHTML = '<div class="validation-banner-header">✅ Survey structure validated — no issues found.</div>';
        banner.className = 'validation-banner ok';
        banner.style.display = 'block';
    }
}

function displaySurveyResponse(data) {
    const responseSection = document.getElementById('responseSection');
    const successMessage = document.getElementById('successMessage');
    const surveyDetails = document.getElementById('surveyDetails');

    // Set survey ID
    document.getElementById('surveyIdDisplay').textContent = data.survey_id;

    // Set questions count
    document.getElementById('questionsCountDisplay').textContent = data.questions_count;

    // Display AI provider used (if available)
    const providerInfo = data.ai_metadata?.provider || 'Unknown';
    const providerBadge = document.createElement('div');
    providerBadge.className = 'detail-item';
    providerBadge.innerHTML = `<label>AI Provider Used:</label><span class="provider-badge">${providerInfo}</span>`;

    // Insert provider info after questions count (find and insert after that element)
    const questionsDetail = document.querySelector('.detail-item:has(+ .detail-item)');
    if (questionsDetail) {
        questionsDetail.insertAdjacentElement('afterend', providerBadge);
    }

    // Display structure
    document.getElementById('structurePreview').textContent = JSON.stringify(data.structure, null, 2);

    // Client-side structure validation banner
    renderValidationBanner('surveyValidationBanner', data.structure);

    // Display warnings if any
    if (data.validation_warnings && data.validation_warnings.length > 0) {
        const warningsSection = document.getElementById('warningsSection');
        const warningsList = document.getElementById('warningsList');

        warningsList.innerHTML = data.validation_warnings
            .map(w => `<li>${w}</li>`)
            .join('');

        warningsSection.style.display = 'block';
    } else {
        document.getElementById('warningsSection').style.display = 'none';
    }

    // Show success message with provider info
    const providerText = data.ai_metadata?.provider ? ` (Generated by: ${data.ai_metadata.provider})` : '';
    successMessage.textContent = data.message + providerText;
    successMessage.style.display = 'block';

    // Show details
    surveyDetails.style.display = 'block';
    responseSection.style.display = 'block';
}

function resetForm() {
    document.getElementById('surveyForm').reset();
    document.getElementById('surveyType').value = '';
    document.getElementById('responseSection').style.display = 'none';
    document.getElementById('surveyForm').style.display = 'block';
    document.getElementById('nameCount').textContent = '0/500';
    document.getElementById('descCount').textContent = '0/2000';
    document.getElementById('contextCount').textContent = '0/50000';
    clearCustomQuestionsUpload();
}

function copySurveyId() {
    const surveyId = document.getElementById('surveyIdDisplay').textContent;
    navigator.clipboard.writeText(surveyId).then(() => {
        showToast('Survey ID copied to clipboard!', 'success');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

function goToDashboard() {
    // Go back to survey creation form to create more surveys
    document.getElementById('surveyForm').style.display = 'block';
    document.getElementById('responseSection').style.display = 'none';

    // Reset form
    document.getElementById('surveyForm').reset();
    document.getElementById('surveyType').value = '';
    document.getElementById('nameCount').textContent = '0/500';
    document.getElementById('descCount').textContent = '0/2000';
    document.getElementById('contextCount').textContent = '0/50000';

    // Scroll to top
    window.scrollTo(0, 0);
}

// ═════════════════════════════════════════════════════════
// PUBLISH/UNPUBLISH SURVEY
// ═════════════════════════════════════════════════════════

async function publishSurvey() {
    const surveyId = document.getElementById('surveyIdDisplay').textContent;

    if (!surveyId) {
        showToast('No survey ID found', 'error');
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to publish survey');
        }

        const data = await response.json();
        showToast(`✅ ${data.message}`, 'success');

        // Update UI to show published status
        document.querySelector('.status-badge').textContent = 'Published (Live)';
        document.querySelector('.status-badge').style.backgroundColor = '#4CAF50';

    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Publish error:', error);
    }
}

async function unpublishSurvey() {
    const surveyId = document.getElementById('surveyIdDisplay').textContent;

    if (!surveyId) {
        showToast('No survey ID found', 'error');
        return;
    }

    if (!confirm('Are you sure you want to unpublish this survey? Users won\'t be able to take it anymore.')) {
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to unpublish survey');
        }

        const data = await response.json();
        showToast(`✅ ${data.message}`, 'success');

        // Update UI to show draft status
        document.querySelector('.status-badge').textContent = 'Draft (Manual Review Required)';
        document.querySelector('.status-badge').style.backgroundColor = '#FF9800';

    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Unpublish error:', error);
    }
}

// ═════════════════════════════════════════════════════════
// SURVEY DETAILS VIEW
// ═════════════════════════════════════════════════════════

function showSurveyDetails(survey) {
    // Hide all sections except survey details
    hideAllSections();
    document.getElementById('surveyDetailsSection').style.display = 'block';

    // Populate survey metadata
    document.getElementById('surveyTitleDetail').textContent = survey.title;
    document.getElementById('surveyDescriptionDetail').textContent = survey.description || 'No description';
    document.getElementById('surveyIdDetail').textContent = survey.id;
    document.getElementById('surveyPointsDetail').textContent = survey.points || 0;
    document.getElementById('surveyMaxResponsesDetail').textContent = survey.max_responses || 100;
    document.getElementById('surveyCreatedDetail').textContent = new Date(survey.created_at).toLocaleDateString();

    // Set status badge
    const statusBadge = document.getElementById('surveyStatusBadge');
    if (survey.is_active) {
        statusBadge.textContent = '✓ Published';
        statusBadge.className = 'status-badge status-active';
    } else {
        statusBadge.textContent = '⏱ Draft';
        statusBadge.className = 'status-badge status-draft';
    }

    // Client-side structure validation banner
    renderValidationBanner('surveyValidationBannerDetail', survey.current_version && survey.current_version.structure);

    // Display questions
    const questionsList = document.getElementById('questionsListDetail');
    if (survey.current_version && survey.current_version.structure && survey.current_version.structure.questions) {
        const questions = survey.current_version.structure.questions;
        document.getElementById('surveyQuestionsDetail').textContent = questions.length;

        questionsList.innerHTML = questions.map((q, idx) => {
            const options = q.answers || q.options || [];
            const optionsHTML = options.length > 0 ? `
                <div style="margin-top: 8px; padding-left: 12px; border-left: 2px solid #e5e7eb;">
                    ${options.map(opt => `<div style="font-size: 0.9em; color: #666; padding: 4px 0;">• ${opt.label || opt.text || opt}</div>`).join('')}
                </div>
            ` : '';
            return `
                <div class="question-item">
                    <strong>Q${idx + 1}:</strong> ${q.label || q.text || 'Untitled Question'}
                    <span class="question-type">(${q.type})</span>
                    ${optionsHTML}
                </div>
            `;
        }).join('');
    } else {
        document.getElementById('surveyQuestionsDetail').textContent = '0';
        questionsList.innerHTML = '<p>No questions available</p>';
    }

    // Show/hide action buttons based on status
    updateActionButtons(survey);

    // Scroll to top
    window.scrollTo(0, 0);
}

function updateActionButtons(survey) {
    const downloadBtn = document.getElementById('downloadReportBtn');
    const downloadMetricsBtn = document.getElementById('downloadMetricsBtn');
    const publishBtn = document.getElementById('publishDetailBtn');
    const unpublishBtn = document.getElementById('unpublishDetailBtn');
    const notifyRemainingBtn = document.getElementById('notifyRemainingBtn');

    const runAnalyticsBtn = document.getElementById('runAnalyticsBtn');
    const analyticsCard = document.getElementById('analyticsCard');

    // Only show download button for published surveys
    if (survey.is_active) {
        downloadBtn.style.display = 'inline-block';
        downloadMetricsBtn.style.display = 'inline-block';
        runAnalyticsBtn.style.display = 'inline-block';
        analyticsCard.style.display = 'block';
        publishBtn.style.display = 'none';
        unpublishBtn.style.display = 'inline-block';
        notifyRemainingBtn.style.display = 'inline-block';

        // Restore analytics state (check for running jobs or existing reports)
        checkExistingAnalyticsState(survey.id);
    } else {
        downloadBtn.style.display = 'none';
        downloadMetricsBtn.style.display = 'none';
        runAnalyticsBtn.style.display = 'none';
        analyticsCard.style.display = 'none';
        publishBtn.style.display = 'inline-block';
        unpublishBtn.style.display = 'none';
        notifyRemainingBtn.style.display = 'none';
    }
}

function backToSurveysList() {
    currentSurveyData = null;
    // Clear analytics polling if running
    if (analyticsPollInterval) {
        clearInterval(analyticsPollInterval);
        analyticsPollInterval = null;
    }
    currentAnalyticsJobId = null;
    showSurveysList();
}

function copySurveyIdDetail() {
    const surveyId = document.getElementById('surveyIdDetail').textContent;
    navigator.clipboard.writeText(surveyId).then(() => {
        showToast('Survey ID copied to clipboard!', 'success');
    }).catch(() => {
        showToast('Failed to copy', 'error');
    });
}

// ═════════════════════════════════════════════════════════
// REPORT GENERATION
// ═════════════════════════════════════════════════════════

async function downloadSurveyReport() {
    if (!currentSurveyData) {
        showToast('No survey data available', 'error');
        return;
    }

    const surveyId = currentSurveyData.id;
    const downloadBtn = document.getElementById('downloadReportBtn');
    const loadingSpinner = document.getElementById('reportLoadingSpinner');

    try {
        // Disable button and show loading state
        downloadBtn.disabled = true;
        downloadBtn.textContent = '⏳ Generating Report...';
        loadingSpinner.style.display = 'flex';

        // Make API call to get PDF
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/report/pdf`, {
            method: 'GET',
        });

        // Handle error responses
        if (!response.ok) {
            const contentType = response.headers.get('content-type');

            // Parse error message
            let errorMessage = 'Failed to generate report';
            if (contentType && contentType.includes('application/json')) {
                try {
                    const errorData = await response.json();
                    errorMessage = errorData.detail || errorMessage;
                } catch (e) {
                    // If JSON parsing fails, use status text
                    errorMessage = response.statusText || errorMessage;
                }
            }

            // Specific error handling
            if (response.status === 400) {
                throw new Error('Invalid survey ID format');
            } else if (response.status === 404) {
                if (errorMessage.includes('No responses') || errorMessage.includes('no responses')) {
                    throw new Error('No responses available yet. Reports can only be generated for surveys with at least one response.');
                } else {
                    throw new Error('Survey not found');
                }
            } else {
                throw new Error(errorMessage);
            }
        }

        // Convert response to blob
        const blob = await response.blob();

        // Create download link
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `survey_${surveyId}_report.pdf`;
        document.body.appendChild(a);
        a.click();

        // Cleanup
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        // Show success message
        showToast('✅ Report downloaded successfully!', 'success');

    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Report download error:', error);
    } finally {
        // Reset button state
        downloadBtn.disabled = false;
        downloadBtn.textContent = '📊 Download Report (PDF)';
        loadingSpinner.style.display = 'none';
    }
}

// ═════════════════════════════════════════════════════════
// METRICS JSON DOWNLOAD
// ═════════════════════════════════════════════════════════

async function downloadMetricsJSON() {
    if (!currentSurveyMetrics || !currentSurveyData) {
        showToast('No metrics data available', 'error');
        return;
    }

    try {
        // Prepare the JSON data with survey info
        const jsonData = {
            survey_id: currentSurveyData.id,
            survey_title: currentSurveyData.title,
            survey_description: currentSurveyData.description,
            exported_at: new Date().toISOString(),
            // Flat headline values averaged across concepts (empty for single-concept
            // surveys). For multi-concept surveys the per-concept truth is in
            // metrics.concepts; these keys mirror what non-multi-concept surveys
            // expose directly under metrics.metrics.
            aggregate_summary: conceptAverages(currentSurveyMetrics && currentSurveyMetrics.concepts),
            metrics: currentSurveyMetrics
        };

        // Convert to JSON string
        const jsonString = JSON.stringify(jsonData, null, 2);

        // Create blob and download
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `survey_${currentSurveyData.id}_metrics.json`;
        document.body.appendChild(a);
        a.click();

        // Cleanup
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        showToast('✅ Metrics JSON downloaded successfully!', 'success');
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('JSON download error:', error);
    }
}

// ═════════════════════════════════════════════════════════
// SURVEY ACTIONS FROM DETAILS
// ═════════════════════════════════════════════════════════

async function publishSurveyFromDetail() {
    if (!currentSurveyData) return;

    await publishSurveyDirect(currentSurveyData.id);

    // Refresh the view with updated data
    await viewSurvey(currentSurveyData.id);
}

async function notifyRemainingFromDetail() {
    if (!currentSurveyData) return;
    await notifyRemainingParticipants(currentSurveyData.id);
}

async function unpublishSurveyFromDetail() {
    if (!currentSurveyData) return;

    // Confirmation dialog
    if (!confirm('Are you sure you want to unpublish this survey? Users won\'t be able to take it anymore.')) {
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${currentSurveyData.id}/unpublish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || 'Failed to unpublish survey');
        }

        const data = await response.json();
        showToast(`✅ ${data.message}`, 'success');

        // Refresh the view
        await viewSurvey(currentSurveyData.id);
    } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
        console.error('Unpublish error:', error);
    }
}


// ═════════════════════════════════════════════════════════
// SURVEY METRICS
// ═════════════════════════════════════════════════════════

async function loadSurveyMetrics(surveyId, excludeLowQuality = false) {
    window._dqSurveyId = surveyId;
    const metricsCard = document.getElementById('metricsCard');

    try {
        const url = `${API_BASE_URL}/api/v1/surveys/${surveyId}/metrics`
            + (excludeLowQuality ? '?exclude_low_quality=true' : '');
        const response = await fetchWithAuth(url);

        if (!response.ok) {
            // If 404 or no data, show card with "no data" message
            if (response.status === 404) {
                metricsCard.style.display = 'block';
                document.getElementById('metricCompletedSessions').textContent = '0';
                document.getElementById('metricTotalResponses').textContent = '0';
                document.getElementById('metricCompletionRate').textContent = '0%';
                document.getElementById('kpiMetrics').innerHTML = '<p class="no-data">No responses yet. Metrics will appear after users complete this survey.</p>';
                document.getElementById('questionAnalyticsSection').style.display = 'none';
                return;
            }
            let detail = `HTTP ${response.status}`;
            try {
                const errData = await response.json();
                detail = errData.detail || detail;
            } catch (e) {}
            throw new Error(detail);
        }

        const data = await response.json();
        displayMetrics(data);
        metricsCard.style.display = 'block';
        initSegmentPicker(surveyId);

        const dqNote = document.getElementById('dqExcludeNote');
        if (dqNote) {
            if (excludeLowQuality && data.quality) {
                dqNote.style.display = 'block';
                dqNote.textContent = `Showing clean sample: ${data.quality.clean_n} of ${data.quality.raw_n} respondents (${data.quality.excluded_n} excluded).`;
            } else {
                dqNote.style.display = 'none';
            }
        }
        if (!excludeLowQuality && typeof loadSurveyQuality === 'function') {
            loadSurveyQuality(surveyId);
        }

    } catch (error) {
        console.error('Metrics load error:', error);
        metricsCard.style.display = 'block';
        document.getElementById('kpiMetrics').innerHTML = `<p class="no-data">Failed to load metrics: ${error.message}</p>`;
    }
}

// ═════════════════════════════════════════════════════════
// PROFILE ATTRIBUTE SEGMENTATION
// ═════════════════════════════════════════════════════════

async function initSegmentPicker(surveyId) {
    const bar = document.getElementById('segmentPickerBar');
    const select = document.getElementById('segmentKeySelect');
    const indicator = document.getElementById('segmentLoadingIndicator');

    // Reset picker state
    select.innerHTML = '<option value="">— All Respondents —</option>';
    bar.style.display = 'none';
    indicator.style.display = 'inline';

    try {
        const res = await fetchWithAuth(`${API_BASE_URL}/api/v1/surveys/${surveyId}/segments`);
        if (!res.ok) return;
        const data = await res.json();
        const segments = data.segments || {};
        if (Object.keys(segments).length === 0) return;

        for (const key of Object.keys(segments)) {
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = formatMetricLabel(key);
            select.appendChild(opt);
        }

        select._segmentsData = segments;
        select._surveyId = surveyId;
        select.onchange = () => {
            const key = select.value;
            if (!key) {
                clearSegmentation();
            } else {
                const values = segments[key] || [];
                onSegmentKeyChange(surveyId, key, values);
            }
        };
        bar.style.display = 'flex';
    } catch (e) {
        console.warn('Segment picker init failed:', e);
    } finally {
        indicator.style.display = 'none';
    }
}

async function onSegmentKeyChange(surveyId, segmentKey, segmentValues) {
    document.getElementById('clearSegmentBtn').style.display = 'inline-block';
    await loadSegmentComparison(surveyId, segmentKey, segmentValues);
}

async function loadSegmentComparison(surveyId, segmentKey, segmentValues) {
    const compView = document.getElementById('segmentComparisonView');
    const kpiGrid = document.getElementById('kpiMetrics');
    const qaSection = document.getElementById('questionAnalyticsSection');

    kpiGrid.style.display = 'none';
    qaSection.style.display = 'none';
    compView.style.display = 'block';
    compView.innerHTML = '<p class="no-data" style="padding: 20px;">Loading segment comparison...</p>';

    const fetches = segmentValues.map(val =>
        fetchWithAuth(
            `${API_BASE_URL}/api/v1/surveys/${surveyId}/metrics/segmented` +
            `?segment_key=${encodeURIComponent(segmentKey)}&segment_value=${encodeURIComponent(val)}`
        )
        .then(r => r.ok ? r.json() : null)
        .catch(() => null)
    );

    const results = await Promise.allSettled(fetches);
    const segmentData = results
        .map((r, i) => (r.status === 'fulfilled' && r.value)
            ? { value: segmentValues[i], data: r.value }
            : null
        )
        .filter(Boolean);

    if (segmentData.length === 0) {
        compView.innerHTML = '<p class="no-data" style="padding: 20px;">No segment data available for the selected attribute.</p>';
        return;
    }

    renderSegmentComparison(segmentKey, segmentData);
}

function renderSegmentComparison(segmentKey, segmentDataArray) {
    const compView = document.getElementById('segmentComparisonView');
    const segmentLabel = formatMetricLabel(segmentKey);

    const kpiMetricLabels = {
        purchase_intent_percent:   { label: 'Purchase Intent',   icon: '🛒', unit: '%' },
        clarity_score:             { label: 'Clarity Score',     icon: '💡', unit: '/5' },
        visual_appeal_score:       { label: 'Visual Appeal',     icon: '🎨', unit: '/5' },
        perceived_quality_score:   { label: 'Perceived Quality', icon: '⭐', unit: '/5' },
        shelf_impact_score:        { label: 'Shelf Impact',      icon: '📦', unit: '/5' },
        repeat_intent_percent:     { label: 'Repeat Intent',     icon: '🔄', unit: '%' },
        appeal_score:              { label: 'Appeal',            icon: '❤️', unit: '' },
        decision_time_median_ms:   { label: 'Decision Time',     icon: '⏱️', unit: 'ms' },
        hesitation_rate_percent:   { label: 'Hesitation Rate',   icon: '🤔', unit: '%' },
        hard_rejection_percent:    { label: 'Hard Rejection',    icon: '🚫', unit: '%' },
        believability_score:       { label: 'Believability',     icon: '✅', unit: '/5' },
        readability_index:         { label: 'Readability',       icon: '📖', unit: '/5' },
    };

    // ── KPI comparison cards ─────────────────────────────────────────────
    let html = `<div class="segment-comparison-section">
        <div class="metrics-section-title">Segment by ${segmentLabel}</div>
        <div class="concept-cards segment-kpi-cards">`;

    for (const seg of segmentDataArray) {
        // Multi-concept segments carry PI / RI / Appeal only under seg.data.concepts —
        // fold in the concept averages so the headline rows are not blank/zero.
        const segConcepts = seg.data.concepts || {};
        const metrics = Object.assign({}, conceptAverages(segConcepts), seg.data.metrics || {});
        html += `<div class="concept-card segment-card">
            <div class="concept-card-title">${seg.value}</div>
            <div class="segment-card-n">n=${seg.data.respondent_count} (${seg.data.percent_of_total}%)</div>`;

        let shownDecisionTime = false;
        let hasAny = false;
        for (const [mKey, info] of Object.entries(kpiMetricLabels)) {
            const val = metrics[mKey];
            if (val == null) continue;
            if (mKey.startsWith('decision_time') && shownDecisionTime) continue;
            if (mKey.startsWith('decision_time')) shownDecisionTime = true;
            hasAny = true;
            const display = typeof val === 'number' ? val.toFixed(1) : val;
            html += `<div class="concept-metric-row">
                <span class="concept-metric-row-icon">${info.icon}</span>
                <span class="concept-metric-row-label">${info.label}</span>
                <span class="concept-metric-row-value">${display}${info.unit}</span>
            </div>`;
        }
        if (!hasAny) {
            html += `<div style="font-size: 12px; color: var(--color-text-tertiary); margin-top: 8px;">No KPI data</div>`;
        }

        // Per-concept breakdown for this segment (the hidden "Concept Comparison" block).
        if (Object.keys(segConcepts).length > 0) {
            const cml = {
                purchase_intent: { label: 'Purchase Intent', icon: '🛒' },
                repeat_intent:   { label: 'Repeat Intent', icon: '🔄' },
                appeal:          { label: 'Appeal', icon: '❤️' },
            };
            let breakdown = '';
            for (const concept of Object.values(segConcepts)) {
                if (!concept || typeof concept !== 'object') continue;
                const parts = Object.entries(cml)
                    .filter(([k]) => typeof concept[k] === 'number')
                    .map(([k, i]) => `${i.icon}&nbsp;${concept[k].toFixed(1)}`)
                    .join('&nbsp;&nbsp;');
                if (!parts) continue;
                breakdown += `<div style="font-size: 11px; color: var(--color-text-secondary); margin-top: 3px;">
                    <span style="font-weight: 600;">${concept.label || 'Concept'}</span> — ${parts}
                </div>`;
            }
            if (breakdown) {
                html += `<div style="margin-top: 10px; border-top: 1px solid var(--color-border, #e5e7eb); padding-top: 8px;">
                    <div style="font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--color-text-tertiary); margin-bottom: 4px;">By concept</div>
                    ${breakdown}
                </div>`;
            }
        }
        html += `</div>`;
    }
    html += `</div>`;

    // ── Per-question analytics by segment ────────────────────────────────
    const allQuestions = {};
    for (const seg of segmentDataArray) {
        for (const qa of (seg.data.question_analytics || [])) {
            if (!allQuestions[qa.question_id]) {
                allQuestions[qa.question_id] = { question_text: qa.question_text, question_type: qa.question_type };
            }
        }
    }

    if (Object.keys(allQuestions).length > 0) {
        html += `<div class="metrics-section-title" style="margin-top: 24px;">Question Analytics by Segment</div>`;

        for (const [qId, qMeta] of Object.entries(allQuestions)) {
            html += `<div class="qa-card">
                <div class="qa-header">
                    <span class="qa-question-text">${qMeta.question_text || qId}</span>
                    <span class="qa-type-badge">${qMeta.question_type || 'unknown'}</span>
                </div>
                <div class="segment-qa-columns">`;

            for (const seg of segmentDataArray) {
                const qa = (seg.data.question_analytics || []).find(q => q.question_id === qId);
                const nCount = qa ? qa.total_responses : 0;
                html += `<div class="segment-qa-col">
                    <div class="segment-qa-col-header">${seg.value} <span class="qa-response-badge">n=${nCount}</span></div>
                    ${qa ? renderQuestionAnalyticsBlock(qa) : '<div class="no-data" style="font-size: 12px; padding: 4px 0;">No data</div>'}
                </div>`;
            }

            html += `</div></div>`;
        }
    }

    html += `</div>`;
    compView.innerHTML = html;
}

function clearSegmentation() {
    const select = document.getElementById('segmentKeySelect');
    if (select) select.value = '';
    document.getElementById('clearSegmentBtn').style.display = 'none';
    document.getElementById('segmentComparisonView').style.display = 'none';
    document.getElementById('kpiMetrics').style.display = '';
    document.getElementById('questionAnalyticsSection').style.display = '';
}

function renderQuestionAnalyticsBlock(qa) {
    let html = '';
    if (qa.question_type === 'multi_slider' && qa.analytics?.sliders) {
        html += `<div>`;
        for (const [sliderId, slider] of Object.entries(qa.analytics.sliders)) {
            const label = slider.label || sliderId;
            const meanVal = slider.mean || 0;
            const barWidth = Math.min((meanVal / 100) * 100, 100);
            html += `<div class="qa-slider-row">
                <span class="qa-row-label">${label}</span>
                <div class="qa-row-bar-bg"><div class="qa-row-bar" style="width: ${barWidth}%"></div></div>
                <span class="qa-row-value">${meanVal.toFixed(1)}</span>
            </div>`;
        }
        html += `</div>`;
    } else if (qa.question_type === 'mcq' && qa.analytics?.options) {
        html += `<div>`;
        for (const [optId, opt] of Object.entries(qa.analytics.options)) {
            const label = opt.label || optId;
            const percent = opt.percent || 0;
            const count = opt.count || 0;
            html += `<div class="qa-option-row">
                <span class="qa-row-label">${label}</span>
                <div class="qa-row-bar-bg"><div class="qa-row-bar" style="width: ${percent}%"></div></div>
                <span class="qa-row-value">${percent.toFixed(1)}% (n=${count})</span>
            </div>`;
        }
        html += `</div>`;
    } else if (qa.question_type === 'ranking' && qa.analytics?.items) {
        const rankingItems = Object.entries(qa.analytics.items)
            .map(([key, item]) => ({
                id: parseRankingKey(key),
                label: item.label || parseRankingKey(key),
                avgRank: item.avg_rank || 0
            }))
            .sort((a, b) => a.avgRank - b.avgRank);

        html += `<div class="qa-rank-list">`;
        rankingItems.forEach((item, idx) => {
            html += `<div class="qa-rank-item">
                <span class="qa-rank-number">${idx + 1}</span>
                <span class="qa-row-label">${item.label}</span>
            </div>`;
        });
        html += `</div>`;
    } else if (qa.question_type === 'text') {
        const responseCount = qa.analytics?.response_count || 0;
        html += `<div class="qa-text-note">📝 ${responseCount} open-ended response${responseCount !== 1 ? 's' : ''} (not displayed)</div>`;
    } else if (qa.question_type === 'image_grid_slider' && qa.analytics?.images) {
        html += `<div>`;
        for (const [imgId, img] of Object.entries(qa.analytics.images)) {
            const label = img.label || imgId;
            const sliderMean = img.slider_mean || 0;
            const barWidth = Math.min((sliderMean / 100) * 100, 100);
            html += `<div class="qa-slider-row">
                <span class="qa-row-label">${label}</span>
                <div class="qa-row-bar-bg"><div class="qa-row-bar" style="width: ${barWidth}%"></div></div>
                <span class="qa-row-value">${sliderMean.toFixed(1)}</span>
            </div>`;
            if (img.selected_count !== undefined) {
                const percent = img.selected_percent || 0;
                html += `<div class="qa-option-row" style="margin-left: 1rem; font-size: 0.85em; opacity: 0.8;">
                    <span class="qa-row-label">Selected</span>
                    <span class="qa-row-value">${percent.toFixed(1)}% (n=${img.selected_count})</span>
                </div>`;
            }
        }
        html += `</div>`;
    }
    return html;
}

function parseRankingKey(keyStr) {
    // Extract 'id' from strings like "{'id': 'price', 'rank': 1}"
    try {
        const match = keyStr.match(/'id':\s*'([^']+)'/);
        return match ? match[1] : keyStr;
    } catch {
        return keyStr;
    }
}

// ── Concept-average headline metrics ─────────────────────────────────────
// Multi-concept surveys return purchase_intent / repeat_intent / appeal ONLY
// per concept (data.concepts[*]) — never as flat data.metrics.* keys. Collapse
// them into flat headline keys (mean across concepts) so the KPI cards, the
// segment view and the JSON export all show real numbers instead of blank/0.
function conceptAverages(concepts) {
    const MAP = {
        purchase_intent: 'purchase_intent_percent',
        repeat_intent:   'repeat_intent_percent',
        appeal:          'appeal_score',
        hard_rejection:  'hard_rejection_percent',
        decision_time:   'decision_time_median_ms',
        hesitation_rate: 'hesitation_rate_percent',
    };
    const buckets = {};
    for (const concept of Object.values(concepts || {})) {
        if (!concept || typeof concept !== 'object') continue;
        for (const [srcKey, flatKey] of Object.entries(MAP)) {
            const v = concept[srcKey];
            if (typeof v === 'number' && !Number.isNaN(v)) {
                (buckets[flatKey] = buckets[flatKey] || []).push(v);
            }
        }
    }
    const out = {};
    for (const [flatKey, vals] of Object.entries(buckets)) {
        if (vals.length) out[flatKey] = vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    return out;
}

function displayMetrics(data) {
    // Store metrics data for download
    currentSurveyMetrics = data;

    // Response stats
    document.getElementById('metricCompletedSessions').textContent = data.completed_sessions || 0;
    document.getElementById('metricTotalResponses').textContent = data.total_responses || 0;
    document.getElementById('metricCompletionRate').textContent =
        `${(data.completion_rate || 0).toFixed(1)}%`;

    // KPI metrics
    const kpiContainer = document.getElementById('kpiMetrics');
    let metrics = data.metrics || {};
    const concepts = data.concepts || {};
    const isMultiConcept = data.is_multi_concept || false;

    // Fold concept-averaged headline values into data.metrics so the KPI cards
    // and the JSON export (currentSurveyMetrics === data) are not blank/zero for
    // multi-concept surveys. Existing flat keys always win over the averages.
    const conceptAveraged = isMultiConcept && Object.keys(concepts).length > 0;
    if (conceptAveraged) {
        data.metrics = Object.assign({}, conceptAverages(concepts), data.metrics || {});
        metrics = data.metrics;
    }

    if ((!metrics || Object.keys(metrics).length === 0) && !isMultiConcept) {
        kpiContainer.innerHTML = '<p class="no-data">No metrics data yet. Metrics are calculated after survey responses are submitted.</p>';
        return;
    }

    let kpiHTML = '';

    // ─── CONCEPT COMPARISON (scrollable card layout) ───
    if (isMultiConcept && Object.keys(concepts).length > 0) {
        const conceptMetricLabels = {
            purchase_intent: { label: 'Purchase Intent', icon: '🛒' },
            repeat_intent: { label: 'Repeat Intent', icon: '🔄' },
            appeal: { label: 'Appeal', icon: '❤️' },
            hard_rejection: { label: 'Hard Rejection', icon: '🚫' },
            decision_time: { label: 'Decision Time', icon: '⏱️' },
            hesitation_rate: { label: 'Hesitation Rate', icon: '🤔' },
        };

        // Collect all metric keys across concepts (excluding "label")
        const allMetricKeys = new Set();
        for (const c of Object.values(concepts)) {
            for (const key of Object.keys(c)) {
                if (key !== 'label') allMetricKeys.add(key);
            }
        }

        const sortedMetricKeys = Array.from(allMetricKeys);

        kpiHTML += `<div class="metrics-section">
            <div class="metrics-section-title">Concept Comparison</div>
            <div class="concept-cards">`;

        for (const [cId, concept] of Object.entries(concepts)) {
            const conceptLabel = concept.label || cId;

            // Find max value for each metric to determine winner
            const metricsForWinner = {};
            for (const mKey of sortedMetricKeys) {
                const values = Object.entries(concepts)
                    .map(([, c]) => c[mKey])
                    .filter(v => v != null);
                metricsForWinner[mKey] = values.length > 0 ? Math.max(...values) : null;
            }

            const isWinner = sortedMetricKeys.some(key => {
                const val = concept[key];
                return val !== null && val !== undefined && val === metricsForWinner[key];
            });

            kpiHTML += `<div class="concept-card ${isWinner ? 'concept-card--winner' : ''}">
                <div class="concept-card-title">${conceptLabel}</div>`;

            for (const mKey of sortedMetricKeys) {
                const val = concept[mKey];
                if (val === null || val === undefined) continue;

                const info = conceptMetricLabels[mKey] || { label: formatMetricLabel(mKey), icon: '📊' };
                const displayVal = typeof val === 'number' ? val.toFixed(1) : val;

                kpiHTML += `<div class="concept-metric-row">
                    <span class="concept-metric-row-icon">${info.icon}</span>
                    <span class="concept-metric-row-label">${info.label}</span>
                    <span class="concept-metric-row-value">${displayVal}</span>
                </div>`;
            }

            kpiHTML += `</div>`;
        }

        kpiHTML += `</div></div>`;
    }

    // ─── SHARED KPI METRICS (smaller cards) ───
    const metricLabels = {
        purchase_intent_percent: { label: 'Purchase Intent', unit: '%', icon: '🛒' },
        clarity_score: { label: 'Clarity Score', unit: '/5', icon: '💡' },
        visual_appeal_score: { label: 'Visual Appeal', unit: '/5', icon: '🎨' },
        perceived_quality_score: { label: 'Perceived Quality', unit: '/5', icon: '⭐' },
        shelf_impact_score: { label: 'Shelf Impact', unit: '/5', icon: '📦' },
        repeat_intent_percent: { label: 'Repeat Intent', unit: '%', icon: '🔄' },
        appeal_score: { label: 'Appeal', unit: '', icon: '❤️' },
        decision_time_median_ms: { label: 'Decision Time', unit: 'ms', icon: '⏱️' },
        decision_time_mean_seconds: { label: 'Decision Time', unit: 's', icon: '⏱️' },
        hesitation_rate_percent: { label: 'Hesitation Rate', unit: '%', icon: '🤔' },
        hard_rejection_percent: { label: 'Hard Rejection', unit: '%', icon: '🚫' },
    };

    let shownDecisionTime = false;
    const kpiCards = [];

    for (const [key, value] of Object.entries(metrics)) {
        if (key === 'pick_rates' || key === 'attribute_drivers') continue;
        if (value === null || value === undefined) continue;

        // Avoid showing both decision_time variants
        if (key === 'decision_time_mean_seconds' && metrics.decision_time_median_ms != null) continue;
        if (key.startsWith('decision_time') && shownDecisionTime) continue;
        if (key.startsWith('decision_time')) shownDecisionTime = true;

        const info = metricLabels[key] || { label: formatMetricLabel(key), unit: '', icon: '📊' };
        const displayValue = typeof value === 'number' ? value.toFixed(1) : value;

        kpiCards.push(`
            <div class="kpi-card">
                <span class="kpi-icon">${info.icon}</span>
                <span class="kpi-value">${displayValue}${info.unit}</span>
                <span class="kpi-label">${info.label}</span>
            </div>
        `);
    }

    if (kpiCards.length > 0) {
        if (conceptAveraged) {
            kpiHTML += `<div class="metrics-section-title" style="margin-top: 4px;">Headline Metrics <span style="font-weight: 400; color: var(--color-text-tertiary);">(avg across concepts)</span></div>`;
        }
        kpiHTML += kpiCards.join('');
    }

    // ─── PICK RATES ───
    if (metrics.pick_rates && Object.keys(metrics.pick_rates).length > 0) {
        kpiHTML += `
            <div class="kpi-card kpi-wide">
                <span class="kpi-icon">🎯</span>
                <span class="kpi-label">Pick Rates</span>
                <div class="pick-rates-list">
                    ${Object.entries(metrics.pick_rates).map(([option, pct]) => {
                        const conceptLabel = concepts[option]?.label || option;
                        return `<div class="pick-rate-item">
                            <span class="pick-rate-label">${conceptLabel}</span>
                            <div class="pick-rate-bar-bg">
                                <div class="pick-rate-bar" style="width: ${pct}%"></div>
                            </div>
                            <span class="pick-rate-value">${pct.toFixed(1)}%</span>
                        </div>`;
                    }).join('')}
                </div>
            </div>
        `;
    }

    // ─── RESPONDENT DEMOGRAPHICS ───
    if (data.respondent_demographics) {
        const demo = data.respondent_demographics;
        const hasAge = demo.age_known_count > 0;
        const hasGender = demo.respondent_count > 0;

        if (hasAge || hasGender) {
            const genderBars = demo.gender_distribution ? Object.entries(demo.gender_distribution)
                .filter(([, stats]) => stats.count > 0)
                .map(([gender, stats]) =>
                    `<div class="pick-rate-item">
                        <span class="pick-rate-label">${gender.charAt(0).toUpperCase() + gender.slice(1)}</span>
                        <div class="pick-rate-bar-bg">
                            <div class="pick-rate-bar" style="width: ${stats.percent}%"></div>
                        </div>
                        <span class="pick-rate-value">${stats.percent.toFixed(1)}% (n=${stats.count})</span>
                    </div>`
                ).join('') : '';

            const ageBars = demo.age_distribution ? Object.entries(demo.age_distribution)
                .filter(([, stats]) => stats.count > 0)
                .map(([range, stats]) =>
                    `<div class="pick-rate-item">
                        <span class="pick-rate-label">${range}</span>
                        <div class="pick-rate-bar-bg">
                            <div class="pick-rate-bar" style="width: ${stats.percent}%"></div>
                        </div>
                        <span class="pick-rate-value">${stats.percent.toFixed(1)}% (n=${stats.count})</span>
                    </div>`
                ).join('') : '';

            kpiHTML += `
                <div class="kpi-card kpi-wide">
                    <span class="kpi-icon">👥</span>
                    <span class="kpi-label">Respondent Demographics</span>
                    <div style="padding: 12px 0;">
                        <div style="margin-bottom: 16px; font-size: 13px;">
                            <span style="font-weight: 500;">Total Respondents:</span> ${demo.respondent_count}
                        </div>
                        ${hasAge ? `
                        <div style="margin-bottom: 16px;">
                            <span style="font-weight: 500; font-size: 13px; display: block; margin-bottom: 8px;">Age Distribution (${demo.age_known_count} with data)</span>
                            <div class="pick-rates-list">
                                ${ageBars}
                            </div>
                        </div>
                        ` : ''}
                        ${hasGender ? `
                        <div style="margin-top: 12px;">
                            <span style="font-weight: 500; font-size: 13px; display: block; margin-bottom: 8px;">Gender Distribution</span>
                            <div class="pick-rates-list">
                                ${genderBars}
                            </div>
                        </div>
                        ` : ''}
                    </div>
                </div>
            `;
        }
    }

    kpiContainer.innerHTML = kpiHTML || '<p class="no-data">No metrics data yet</p>';

    // ─── QUESTION ANALYTICS ───
    const qaSection = document.getElementById('questionAnalyticsSection');

    if (data.question_analytics && data.question_analytics.length > 0) {
        let qaHTML = `<div class="metrics-section-title">Question Analytics</div>`;

        for (const qa of data.question_analytics) {
            const questionText = qa.question_text || qa.question_id;
            const totalResponses = qa.total_responses || 0;

            qaHTML += `<div class="qa-card">
                <div class="qa-header">
                    <span class="qa-question-text">${questionText}</span>
                    <span class="qa-type-badge">${qa.question_type || 'unknown'}</span>
                    <span class="qa-response-badge">n=${totalResponses}</span>
                </div>`;

            qaHTML += renderQuestionAnalyticsBlock(qa);
            qaHTML += `</div>`;
        }

        qaSection.innerHTML = qaHTML;
        qaSection.style.display = 'block';
    } else {
        qaSection.style.display = 'none';
    }
}

function formatMetricLabel(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}


// ss: collect concept labels and image URLs from concept cards
function getConceptsFromForm() {
    const cards = document.getElementById('conceptCards');
    if (!cards) return [];
    const concepts = [];
    Array.from(cards.children).forEach((card) => {
        const idMatch = card.id.match(/concept-card-(\d+)/);
        if (!idMatch) return;
        const cid = idMatch[1];
        const label = (document.getElementById(`concept-label-${cid}`)?.value || '').trim();
        const imageUrl = (document.getElementById(`concept-imageurl-${cid}`)?.value || '').trim();
        if (label) {
            concepts.push({
                id: label.toLowerCase().replace(/\s+/g, '_'),
                label,
                image_url: imageUrl || null
            });
        }
    });
    return concepts;
}

// ═════════════════════════════════════════════════════════
// ADMIN NOTIFICATIONS
// ═════════════════════════════════════════════════════════

function showNotifications() {
    hideAllSections();
    document.getElementById('notificationsSection').style.display = 'block';
    setActiveTab('notifications');
    loadRecentNotifications();
    window.scrollTo(0, 0);
}

function showBackfillDemographics() {
    hideAllSections();
    document.getElementById('backfillDemographicsSection').style.display = 'block';
    setActiveTab('backfill-demographics');
    document.getElementById('backfillResultsSection').style.display = 'none';
    window.scrollTo(0, 0);
}

function updateBackfillUI() {
    // Update UI based on selected mode
    const mode = document.querySelector('input[name="backfillMode"]:checked').value;
    const surveyIdInput = document.getElementById('backfillSurveyId');

    if (mode === 'single') {
        surveyIdInput.style.display = 'block';
    } else {
        surveyIdInput.style.display = 'none';
    }
}

function hideBackfillResults() {
    document.getElementById('backfillResultsSection').style.display = 'none';
}

async function dryRunSingleSurvey() {
    const surveyId = document.getElementById('backfillSurveyId').value.trim();
    if (!surveyId) {
        showToast('❌ Please enter a Survey ID', 'error');
        return;
    }
    await backfillDemographics(surveyId, true, 'single');
}

async function backfillSingleSurvey() {
    const surveyId = document.getElementById('backfillSurveyId').value.trim();
    if (!surveyId) {
        showToast('❌ Please enter a Survey ID', 'error');
        return;
    }
    if (!confirm(`Backfill demographics for survey ${surveyId}? This will recalculate and update demographic data.`)) return;
    await backfillDemographics(surveyId, false, 'single');
}

async function dryRunAllSurveys() {
    await backfillDemographics(null, true, 'all');
}

async function backfillAllSurveys() {
    if (!confirm('⚠️ Backfill demographics for ALL surveys? This will process all surveys with completed responses. Continue?')) return;
    await backfillDemographics(null, false, 'all');
}

async function backfillDemographics(surveyId, dryRun, mode) {
    try {
        showToast('Processing backfill...', 'info');
        document.getElementById('backfillResultsSection').style.display = 'block';
        document.getElementById('backfillResultsContent').textContent = 'Processing...';

        let url = `${API_BASE_URL}/api/v1/admin/backfill-demographics?dry_run=${dryRun}`;
        if (surveyId) {
            url += `&survey_id=${surveyId}`;
        }

        const response = await fetchWithAuth(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || `HTTP ${response.status}`);
        }

        const result = await response.json();

        // Format results for display
        let resultText = `${dryRun ? '🔍 DRY RUN' : '✅ EXECUTED'} - ${result.mode.toUpperCase()} BACKFILL\n`;
        resultText += `Surveys Processed: ${result.surveys_processed}\n`;
        resultText += `Dry Run Mode: ${dryRun}\n`;
        resultText += `\n${'='.repeat(80)}\n\n`;

        if (result.backfill_details && result.backfill_details.length > 0) {
            result.backfill_details.forEach((detail, idx) => {
                resultText += `Survey ${idx + 1}/${result.surveys_processed}\n`;
                resultText += `  Survey ID: ${detail.survey_id}\n`;
                resultText += `  Title: ${detail.survey_title}\n`;
                resultText += `  Changed: ${detail.changed ? 'YES' : 'NO'}\n\n`;

                if (detail.before) {
                    resultText += `  BEFORE (Old Demographics):\n`;
                    resultText += `${JSON.stringify(detail.before, null, 4).split('\n').map(l => '    ' + l).join('\n')}\n\n`;
                }

                if (detail.after) {
                    resultText += `  AFTER (New Demographics):\n`;
                    resultText += `${JSON.stringify(detail.after, null, 4).split('\n').map(l => '    ' + l).join('\n')}\n\n`;
                }

                resultText += `${'-'.repeat(80)}\n\n`;
            });
        }

        document.getElementById('backfillResultsContent').textContent = resultText;

        if (dryRun) {
            showToast(`✅ Dry run complete! Reviewed ${result.surveys_processed} survey(s)`, 'success');
        } else {
            showToast(`✅ Backfill complete! Updated ${result.surveys_processed} survey(s)`, 'success');
        }

    } catch (error) {
        console.error('Backfill error:', error);
        document.getElementById('backfillResultsContent').textContent = `ERROR:\n\n${error.message}`;
        showToast(`❌ Backfill failed: ${error.message}`, 'error');
    }
}

async function sendCustomNotification() {
    const title = document.getElementById('notifTitle').value.trim();
    const body = document.getElementById('notifBody').value.trim();
    const type = document.getElementById('notifType').value;

    if (!title || !body) {
        showToast('❌ Title and message are required', 'error');
        return;
    }

    if (!confirm(`Send "${title}" to ALL users? This cannot be undone.`)) return;

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/notifications/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: title,
                body: body,
                notification_type: type
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Failed to send notification');
        }

        const data = await response.json();
        showToast(`✅ Sent to ${data.success_count} users!`, 'success');

        // Clear form
        document.getElementById('notifTitle').value = '';
        document.getElementById('notifBody').value = '';

        // Refresh history
        loadRecentNotifications();
    } catch (error) {
        showToast(`❌ ${error.message}`, 'error');
    }
}

async function loadRecentNotifications() {
    const container = document.getElementById('recentNotifsList');
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/notifications/recent`);
        if (!response.ok) throw new Error('Failed to load');
        const items = await response.json();

        if (items.length === 0) {
            container.innerHTML = '<p style="color: #999;">No notifications sent yet.</p>';
            return;
        }

        const tableHTML = `
            <table class="surveys-table">
                <thead>
                    <tr>
                        <th>Title</th>
                        <th>Type</th>
                        <th>Recipients</th>
                        <th>Sent At</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map(n => {
                        const sentAt = new Date(n.created_at).toLocaleString();
                        const preview = n.body.substring(0, 80) + (n.body.length > 80 ? '...' : '');
                        return `
                            <tr>
                                <td>
                                    <strong>${n.title}</strong><br>
                                    <small style="color: #666;">${preview}</small>
                                </td>
                                <td><span class="status-active">${n.notification_type}</span></td>
                                <td>${n.recipient_count}</td>
                                <td>${sentAt}</td>
                            </tr>
                        `;
                    }).join('')}
                </tbody>
            </table>
        `;
        container.innerHTML = tableHTML;
    } catch (error) {
        container.innerHTML = `<p style="color: red;">Error loading history: ${error.message}</p>`;
    }
}

// ═══════════════════════════════════════════════════════════
// BACKFILL METRICS FUNCTIONS
// ═══════════════════════════════════════════════════════════

function showBackfillMetrics() {
    hideAllSections();
    document.getElementById('backfillMetricsSection').style.display = 'block';
    setActiveTab('backfill-metrics');
    document.getElementById('backfillMetricsResultsSection').style.display = 'none';
    window.scrollTo(0, 0);
}

function updateBackfillMetricsUI() {
    // Update UI based on selected mode
    const mode = document.querySelector('input[name="backfillMetricsMode"]:checked').value;
    const surveyIdInput = document.getElementById('backfillMetricsSurveyId');

    if (mode === 'single') {
        surveyIdInput.style.display = 'block';
    } else {
        surveyIdInput.style.display = 'none';
    }
}

function hideBackfillMetricsResults() {
    document.getElementById('backfillMetricsResultsSection').style.display = 'none';
}

async function dryRunMetricsSingleSurvey() {
    const surveyId = document.getElementById('backfillMetricsSurveyId').value.trim();
    if (!surveyId) {
        showToast('❌ Please enter a Survey ID', 'error');
        return;
    }
    await backfillMetrics(surveyId, true, 'single');
}

async function backfillMetricsSingleSurvey() {
    const surveyId = document.getElementById('backfillMetricsSurveyId').value.trim();
    if (!surveyId) {
        showToast('❌ Please enter a Survey ID', 'error');
        return;
    }
    if (!confirm(`Recalculate metrics for survey ${surveyId}? This will recalculate Decision Time and Hesitation using the latest formulas.`)) return;
    await backfillMetrics(surveyId, false, 'single');
}

async function dryRunMetricsAllSurveys() {
    await backfillMetrics(null, true, 'all');
}

async function backfillMetricsAllSurveys() {
    if (!confirm('⚠️ Recalculate metrics for ALL surveys? This will process all surveys with completed responses using the latest formulas. Continue?')) return;
    await backfillMetrics(null, false, 'all');
}

async function backfillMetrics(surveyId, dryRun, mode) {
    try {
        showToast('Processing metrics backfill...', 'info');
        document.getElementById('backfillMetricsResultsSection').style.display = 'block';
        document.getElementById('backfillMetricsResultsContent').textContent = 'Processing...';

        let url = `${API_BASE_URL}/api/v1/admin/backfill-metrics?dry_run=${dryRun}`;
        if (surveyId) {
            url += `&survey_id=${surveyId}`;
        }

        const response = await fetchWithAuth(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.detail || `HTTP ${response.status}`);
        }

        const result = await response.json();

        // Format results for display
        let resultText = `${dryRun ? '🔍 DRY RUN' : '✅ EXECUTED'} - ${result.mode.toUpperCase()} BACKFILL\n`;
        resultText += `Surveys Processed: ${result.surveys_processed}\n`;
        resultText += `Dry Run Mode: ${dryRun}\n`;
        resultText += `\n${'='.repeat(80)}\n\n`;

        if (result.backfill_details && result.backfill_details.length > 0) {
            result.backfill_details.forEach((detail, idx) => {
                resultText += `Survey ${idx + 1}/${result.surveys_processed}\n`;
                resultText += `  Survey ID: ${detail.survey_id}\n`;
                resultText += `  Title: ${detail.survey_title}\n`;
                resultText += `  Status: ${detail.status || 'success'}\n`;

                if (detail.completed_sessions !== undefined) {
                    resultText += `  Completed Sessions: ${detail.completed_sessions}\n`;
                }

                if (detail.old_metric_count !== undefined && detail.new_metric_count !== undefined) {
                    resultText += `  Metrics Before: ${detail.old_metric_count}\n`;
                    resultText += `  Metrics After: ${detail.new_metric_count}\n`;
                }

                if (detail.error) {
                    resultText += `  Error: ${detail.error}\n`;
                }

                resultText += `${'-'.repeat(80)}\n\n`;
            });
        }

        document.getElementById('backfillMetricsResultsContent').textContent = resultText;

        if (dryRun) {
            showToast(`✅ Dry run complete! Reviewed ${result.surveys_processed} survey(s)`, 'success');
        } else {
            showToast(`✅ Backfill complete! Updated ${result.surveys_processed} survey(s)`, 'success');
        }

    } catch (error) {
        console.error('Metrics backfill error:', error);
        document.getElementById('backfillMetricsResultsContent').textContent = `ERROR:\n\n${error.message}`;
        showToast(`❌ Backfill failed: ${error.message}`, 'error');
    }
}

// ═════════════════════════════════════════════════════════════════
// EMAIL BROADCAST
// ═════════════════════════════════════════════════════════════════

function showEmailBroadcast() {
    hideAllSections();
    document.getElementById('emailBroadcastSection').style.display = 'block';
    setActiveTab('email');
    loadEmailBroadcastHistory();
    window.scrollTo(0, 0);
}

async function sendEmailBroadcast() {
    const subject = document.getElementById('broadcastSubject').value.trim();
    const bodyHtml = document.getElementById('broadcastBody').value.trim();
    const bodyText = document.getElementById('broadcastBodyText').value.trim() || null;
    const filter = document.getElementById('broadcastFilter').value;

    if (!subject || !bodyHtml) {
        showToast('❌ Subject and message body are required', 'error');
        return;
    }

    const filterLabel = filter === 'verified' ? 'verified users' : 'all active users';
    if (!confirm(`Send "${subject}" to ALL ${filterLabel}? This cannot be undone.`)) return;

    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/email/broadcast`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                subject: subject,
                body_html: bodyHtml,
                body_text: bodyText,
                recipient_filter: filter
            })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Failed to queue email broadcast');
        }

        const data = await response.json();
        showToast(`✅ Email broadcast queued for ${data.total_recipients} recipients!`, 'success');

        // Clear form
        document.getElementById('broadcastSubject').value = '';
        document.getElementById('broadcastBody').value = '';
        document.getElementById('broadcastBodyText').value = '';

        // Refresh history after a short delay to let background task update status
        setTimeout(() => loadEmailBroadcastHistory(), 2000);
    } catch (error) {
        showToast(`❌ ${error.message}`, 'error');
    }
}

async function loadEmailBroadcastHistory() {
    const container = document.getElementById('emailBroadcastHistoryList');
    try {
        const response = await fetchWithAuth(`${API_BASE_URL}/api/v1/admin/email/broadcasts`);
        if (!response.ok) throw new Error('Failed to load broadcast history');
        const items = await response.json();

        if (items.length === 0) {
            container.innerHTML = '<p style="color: #999;">No broadcasts sent yet.</p>';
            return;
        }

        const tableHTML = `
            <table class="surveys-table">
                <thead>
                    <tr>
                        <th>Subject</th>
                        <th>Filter</th>
                        <th>Status</th>
                        <th>Sent / Failed</th>
                        <th>Initiated By</th>
                        <th>Sent At</th>
                    </tr>
                </thead>
                <tbody>
                    ${items.map(item => `
                        <tr>
                            <td>${item.subject}</td>
                            <td>${item.recipient_filter}</td>
                            <td><span style="color: ${item.status === 'completed' ? '#2e7d32' : item.status === 'failed' ? '#c62828' : '#f57c00'}; font-weight: 600;">${item.status}</span></td>
                            <td>${item.sent_count} / ${item.failed_count}</td>
                            <td style="font-size: 12px; color: #666;">${item.initiated_by}</td>
                            <td style="font-size: 12px;">${new Date(item.created_at).toLocaleString()}</td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `;
        container.innerHTML = tableHTML;
    } catch (error) {
        container.innerHTML = `<p style="color: #c00;">Failed to load history: ${error.message}</p>`;
    }
}

// ═════════════════════════════════════════════════════════
// ANALYTICS PIPELINE
// ═════════════════════════════════════════════════════════

function showAnalyticsModal() {
    // Reset validation
    document.getElementById('weightsValidation').style.display = 'none';
    // Reset to defaults
    document.getElementById('weightCs').value = '0.6';
    document.getElementById('weightBq').value = '0.2';
    document.getElementById('weightPq').value = '0.2';
    document.getElementById('eiDuration').value = '15';
    document.getElementById('startPipelineBtn').disabled = false;
    document.getElementById('startPipelineBtn').textContent = '🚀 Start Pipeline';
    document.getElementById('analyticsWeightsModal').style.display = 'flex';
}

function closeAnalyticsModal() {
    document.getElementById('analyticsWeightsModal').style.display = 'none';
}

async function startAnalyticsPipeline() {
    if (!currentSurveyData) {
        showToast('No survey data available', 'error');
        return;
    }

    const surveyId = currentSurveyData.id;

    // ── Duplicate job guard ──────────────────────────────────────────────
    const existingJob = getAnalyticsJob(surveyId);
    if (existingJob) {
        try {
            const statusResp = await fetch(
                `${ANALYTICS_ENGINE_URL}/pipeline/status/${existingJob.jobId}`
            );
            if (statusResp.ok) {
                const statusData = await statusResp.json();
                if (statusData.status === 'running') {
                    // Job is still running — warn user and resume polling instead
                    showToast('⚠️ A pipeline is already running for this survey. Resuming status tracking.', 'info');
                    closeAnalyticsModal();
                    currentAnalyticsJobId = existingJob.jobId;

                    document.getElementById('analyticsCard').style.display = 'block';
                    document.getElementById('analyticsRefreshBtn').style.display = 'inline-block';
                    document.getElementById('pipelineSteps').style.display = 'block';
                    renderPipelineSteps(statusData.steps || []);
                    updateAnalyticsContent(`⏳ Pipeline already running — Job: ${existingJob.jobId}`);
                    startAnalyticsPolling();
                    return;
                } else {
                    // Job finished — clear it and allow re-run
                    clearAnalyticsJob(surveyId);
                }
            } else {
                // Engine doesn't know this job — clear stale entry
                clearAnalyticsJob(surveyId);
            }
        } catch (err) {
            console.warn('[Analytics] Failed to check existing job, proceeding with new run:', err);
            clearAnalyticsJob(surveyId);
        }
    }
    // ── End duplicate job guard ──────────────────────────────────────────

    // Validate weights
    const cs = parseFloat(document.getElementById('weightCs').value) || 0;
    const bq = parseFloat(document.getElementById('weightBq').value) || 0;
    const pq = parseFloat(document.getElementById('weightPq').value) || 0;
    const eiDuration = parseInt(document.getElementById('eiDuration').value) || 15;
    const sum = cs + bq + pq;

    if (Math.abs(sum - 1.0) > 0.01) {
        const validationEl = document.getElementById('weightsValidation');
        validationEl.textContent = `Weights must sum to 1.0 (currently ${sum.toFixed(2)})`;
        validationEl.style.display = 'block';
        return;
    }

    const startBtn = document.getElementById('startPipelineBtn');
    startBtn.disabled = true;
    startBtn.textContent = '⏳ Starting...';

    try {
        // Step 1: Upload survey summary to GCS
        showToast('📤 Uploading survey summary to GCS...', 'success');
        updateAnalyticsContent('📤 Uploading survey summary to GCS...');

        const uploadResponse = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/surveys/${surveyId}/upload-summary`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } }
        );

        if (!uploadResponse.ok) {
            const err = await uploadResponse.json();
            throw new Error(err.detail || 'Failed to upload survey summary');
        }

        const uploadData = await uploadResponse.json();
        const signedUrl = uploadData.signed_url;
        const bucketName = uploadData.bucket;

        showToast('✅ Survey summary uploaded. Starting analytics pipeline...', 'success');
        updateAnalyticsContent('✅ Uploaded to GCS. Starting analytics pipeline...');

        // Step 2: Generate a client-side job_id so we can poll immediately
        const jobId = `pipeline_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        currentAnalyticsJobId = jobId;

        // Persist job to localStorage so it survives logout/reload
        saveAnalyticsJob(surveyId, jobId);

        // Step 3: Trigger analytics pipeline (blocking POST — runs in background)
        const pipelineBody = {
            survey_id: surveyId,
            signed_url: signedUrl,
            bucket_name: bucketName,
            exec_summary_weights: { cs, bq, pq },
            survey_title: currentSurveyData.title || null,
            collection_duration_minutes: eiDuration,
            job_id: jobId,
        };

        // Fire the POST in the background — it blocks for ~16-18 min
        const pipelinePromise = fetch(`${ANALYTICS_ENGINE_URL}/pipeline/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(pipelineBody),
            signal: AbortSignal.timeout(2400000), // 40 min timeout
        }).then(async (response) => {
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.detail || `Pipeline failed (HTTP ${response.status})`);
            }
            const result = await response.json();

            // POST completed — stop polling and show final result
            if (analyticsPollInterval) {
                clearInterval(analyticsPollInterval);
                analyticsPollInterval = null;
            }

            // Clear/update localStorage on terminal state
            if (result.status === 'completed') {
                clearAnalyticsJob(surveyId);
            } else if (result.status === 'failed' || result.status === 'partial_failure') {
                clearAnalyticsJob(surveyId);
            }

            if (result.status === 'failed') {
                showToast(`❌ Pipeline failed: ${result.error || 'Unknown error'}`, 'error');
                updateAnalyticsContent(`❌ Pipeline failed: ${result.error || 'Unknown error'}`);
            } else if (result.status === 'partial_failure') {
                showToast('⚠️ Pipeline completed with partial failures', 'error');
            } else {
                showToast('✅ Analytics pipeline completed!', 'success');
            }

            // Render final state from the POST response
            renderPipelineSteps(result.steps || []);
            if (result.output_files && Object.keys(result.output_files).length > 0) {
                renderAnalyticsResults(result);
            }
            if (result.output_files?.pdf_report) {
                document.getElementById('downloadAnalyticsPdfBtn').style.display = 'inline-block';
            }

            const duration = result.duration_seconds
                ? ` (${Math.round(result.duration_seconds)}s)`
                : '';
            updateAnalyticsContent(
                `✅ Status: <strong>${result.status}</strong>${duration} — Job: ${jobId}`
            );

            return result;
        }).catch((err) => {
            // Only surface if this job is still active
            if (currentAnalyticsJobId === jobId) {
                showToast(`❌ Pipeline error: ${err.message}`, 'error');
                updateAnalyticsContent(`❌ Pipeline error: ${err.message}`);
                console.error('Pipeline POST error:', err);
                clearAnalyticsJob(surveyId);
            }
        });

        // Step 4: Show progress UI immediately
        showToast(`🚀 Pipeline started! Job: ${jobId}`, 'success');
        closeAnalyticsModal();

        document.getElementById('analyticsCard').style.display = 'block';
        document.getElementById('analyticsRefreshBtn').style.display = 'inline-block';
        document.getElementById('pipelineSteps').style.display = 'block';

        updateAnalyticsContent(`🚀 Pipeline running — Job: ${jobId}`);

        // Step 5: Wait 3s for Firestore job record to be created, then start polling
        setTimeout(() => {
            if (currentAnalyticsJobId === jobId) {
                startAnalyticsPolling();
            }
        }, 3000);

    } catch (error) {
        showToast(`❌ Analytics error: ${error.message}`, 'error');
        updateAnalyticsContent(`❌ Error: ${error.message}`);
        console.error('Analytics pipeline error:', error);
    } finally {
        startBtn.disabled = false;
        startBtn.textContent = '🚀 Start Pipeline';
    }
}

function updateAnalyticsContent(message) {
    document.getElementById('analyticsContent').innerHTML =
        `<p style="font-size: 14px; color: #1a1a1a; margin: 8px 0; font-weight: 500;">${message}</p>`;
}

function startAnalyticsPolling() {
    // Clear any existing interval
    if (analyticsPollInterval) clearInterval(analyticsPollInterval);

    // Poll immediately once
    refreshAnalyticsStatus();

    // Then poll every N seconds
    analyticsPollInterval = setInterval(refreshAnalyticsStatus, ANALYTICS_POLL_INTERVAL_MS);
}

async function refreshAnalyticsStatus() {
    if (!currentAnalyticsJobId) {
        if (analyticsPollInterval) clearInterval(analyticsPollInterval);
        return;
    }

    try {
        const response = await fetch(
            `${ANALYTICS_ENGINE_URL}/pipeline/status/${currentAnalyticsJobId}`
        );

        if (!response.ok) {
            console.warn('Failed to poll pipeline status:', response.status);
            return;
        }

        const data = await response.json();

        // Render steps
        renderPipelineSteps(data.steps || []);

        // Update status message
        const statusEmoji = {
            running: '⏳',
            completed: '✅',
            failed: '❌',
            partial_failure: '⚠️',
        };
        const emoji = statusEmoji[data.status] || '🔄';
        const duration = data.duration_seconds
            ? ` (${Math.round(data.duration_seconds)}s)`
            : '';

        updateAnalyticsContent(
            `${emoji} Status: <strong>${data.status}</strong>${duration} — Job: ${currentAnalyticsJobId}`
        );

        // Terminal states: stop polling
        if (['completed', 'failed', 'partial_failure'].includes(data.status)) {
            if (analyticsPollInterval) {
                clearInterval(analyticsPollInterval);
                analyticsPollInterval = null;
            }

            // Clear localStorage for this survey's job
            if (currentSurveyData) {
                clearAnalyticsJob(currentSurveyData.id);
            }

            // Show results
            if (data.output_files && Object.keys(data.output_files).length > 0) {
                renderAnalyticsResults(data);
            }

            // Show download PDF button if PDF was generated
            if (data.output_files?.pdf_report) {
                document.getElementById('downloadAnalyticsPdfBtn').style.display = 'inline-block';
            }

            if (data.status === 'completed') {
                showToast('✅ Analytics pipeline completed!', 'success');
            } else if (data.status === 'failed') {
                showToast(`❌ Pipeline failed: ${data.error || 'Unknown error'}`, 'error');
            } else {
                showToast('⚠️ Pipeline completed with partial failures', 'error');
            }
        }

    } catch (error) {
        console.error('Error polling analytics status:', error);
    }
}

function renderPipelineSteps(steps) {
    const container = document.getElementById('pipelineSteps');
    container.style.display = 'block';

    const stepLabels = {
        download_survey_aggregate: 'Download Survey Data',
        build_survey_context: 'Build Survey Context',
        run_ei_collection: 'Run EI Collection',
        fetch_ei_insights: 'Fetch EI Insights',
        upload_ei_output: 'Upload EI Output',
        generate_analytics_report: 'Generate Analytics Report',
        upload_analytics_report: 'Upload Analytics Report',
        generate_pdf: 'Generate PDF',
        upload_pdf: 'Upload PDF',
    };

    const stepIcons = {
        pending: '⏸',
        running: '<span class="step-spinner">⏳</span>',
        completed: '✅',
        failed: '❌',
        skipped: '⏭',
    };

    const stepColors = {
        pending: '#999',
        running: '#1976D2',
        completed: '#2e7d32',
        failed: '#c62828',
        skipped: '#888',
    };

    let html = '<div style="padding: 12px 0;">';
    steps.forEach((step, idx) => {
        const label = stepLabels[step.step] || step.step;
        const icon = stepIcons[step.status] || '⏸';
        const color = stepColors[step.status] || '#999';
        const duration = step.duration_seconds
            ? `<span style="color: #888; font-size: 11px; margin-left: 8px;">${step.duration_seconds.toFixed(1)}s</span>`
            : '';
        const message = step.message
            ? `<div style="font-size: 11px; color: #888; margin-left: 28px; margin-top: 2px;">${step.message}</div>`
            : '';

        html += `
            <div style="display: flex; align-items: center; padding: 6px 0;
                        ${idx < steps.length - 1 ? 'border-bottom: 1px solid #f0f0f0;' : ''}">
                <span style="width: 24px; text-align: center; font-size: 14px;">${icon}</span>
                <span style="flex: 1; font-size: 13px; color: ${color}; font-weight: ${step.status === 'running' ? '600' : '400'};">
                    ${label}
                </span>
                ${duration}
            </div>
            ${message}
        `;
    });
    html += '</div>';

    // Add CSS for spinner animation if not already added
    if (!document.getElementById('stepSpinnerStyle')) {
        const style = document.createElement('style');
        style.id = 'stepSpinnerStyle';
        style.textContent = `
            .step-spinner {
                display: inline-block;
                animation: stepSpin 1.2s linear infinite;
            }
            @keyframes stepSpin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    container.innerHTML = html;
}

function renderAnalyticsResults(data) {
    const resultsDiv = document.getElementById('analyticsResults');
    const contentDiv = document.getElementById('analyticsResultsContent');
    resultsDiv.style.display = 'block';

    let html = '';

    // Output files
    if (data.output_files) {
        html += '📁 Output Files:\n';
        for (const [key, uri] of Object.entries(data.output_files)) {
            html += `  • ${key}: ${uri}\n`;
        }
        html += '\n';
    }

    // Duration
    if (data.duration_seconds) {
        html += `⏱ Total Duration: ${Math.round(data.duration_seconds)}s\n\n`;
    }

    // Analytics report summary (if present)
    if (data.analytics_report) {
        html += '📊 Analytics Report Summary:\n';
        const report = data.analytics_report;
        if (report.concept_evaluation) {
            const ce = report.concept_evaluation;
            html += `  Composite Score: ${ce.composite_score}/100\n`;
            if (ce.concept_strength) html += `  Strength: ${ce.concept_strength}\n`;
            if (ce.winner) html += `  Winner: ${ce.winner} (${ce.winner_pick_rate}%)\n`;
            if (ce.decision_clarity) html += `  Decision Clarity: ${ce.decision_clarity}\n`;
        }
        if (report.narrative) {
            html += `\n  Headline: ${report.narrative.headline}\n`;
        }
    }

    // Error
    if (data.error) {
        html += `\n❌ Error: ${data.error}\n`;
    }

    contentDiv.textContent = html;
}

async function downloadAnalyticsPdf() {
    if (!currentSurveyData) {
        showToast('No survey data available', 'error');
        return;
    }

    const btn = document.getElementById('downloadAnalyticsPdfBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Getting download link...';

    try {
        const response = await fetchWithAuth(
            `${API_BASE_URL}/api/v1/surveys/${currentSurveyData.id}/analytics/download/pdf`
        );

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.detail || 'Failed to get download URL');
        }

        const data = await response.json();

        // Open signed URL in new tab to trigger download
        window.open(data.download_url, '_blank');
        showToast('📄 PDF download started!', 'success');

    } catch (error) {
        showToast(`❌ Download error: ${error.message}`, 'error');
        console.error('PDF download error:', error);
    } finally {
        btn.disabled = false;
        btn.textContent = '📄 Download PDF';
    }
}

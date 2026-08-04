// ═════════════════════════════════════════════════════════
// AUTHENTICATION
// login, logout, session restore, env switching
// Depends on globals defined in app.js:
//   API_BASE_URL, TOKEN_KEY, REFRESH_TOKEN_KEY, USER_KEY,
//   TENANT_ID_KEY, ENV_KEY, API_URL_PROD, API_URL_DEV,
//   currentToken, currentUser
// ═════════════════════════════════════════════════════════

async function login() {
    const email = document.getElementById('authEmail').value;
    const password = document.getElementById('authPassword').value;

    if (!email || !password) {
        showToast('Please enter email and password', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE_URL}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        if (!response.ok) {
            throw new Error('Login failed');
        }

        const data = await response.json();
        currentToken = data.access_token;
        currentUser = data.user;

        localStorage.setItem(TOKEN_KEY, currentToken);
        localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
        if (data.refresh_token) {
            localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token);
        }

        startRefreshTimer();
        showToast('Login successful!', 'success');
        showMainPanel();
    } catch (error) {
        showToast(`Login failed: ${error.message}`, 'error');
    }
}

function logout() {
    stopRefreshTimer();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TENANT_ID_KEY);
    currentToken = null;
    currentUser = null;

    const surveyForm = document.getElementById('surveyForm');
    if (surveyForm) surveyForm.reset();
    const responseSection = document.getElementById('responseSection');
    if (responseSection) responseSection.style.display = 'none';

    document.getElementById('authSection').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('authEmail').value = '';
    document.getElementById('authPassword').value = '';

    showToast('Logged out successfully', 'success');
}

function showMainPanel() {
    const authSection = document.getElementById('authSection');
    const app = document.getElementById('app');

    if (authSection) authSection.style.display = 'none';
    if (app) app.style.display = 'grid';

    // Wire up sidebar nav clicks
    const sectionMap = {
        dashboard: showDashboard,
        surveys: showSurveysList,
        create: showSurveyForm,
        notifications: showNotifications,
        email: showEmailBroadcast,
        panels: showPanels,
        'profile-questionnaires': showProfileQuestionnaires,
        'profile-attributes': showProfileAttributes,
        'backfill-demographics': showBackfillDemographics,
        'backfill-metrics': showBackfillMetrics,
        validator: showValidatorPage,
        redemptions: showRedemptions,
        'user-quality': showUserQuality,
    };
    document.querySelectorAll('.nav-item[data-section]').forEach(item => {
        item.addEventListener('click', () => sectionMap[item.dataset.section]?.());
    });

    // Wire up sidebar env toggle (auth screen toggle uses inline onclick)
    document.querySelectorAll('#sidebar .env-btn[data-env]').forEach(btn => {
        btn.addEventListener('click', () => switchEnvironment(btn.dataset.env));
    });

    loadTenants();
    showDashboard();
}

// ═════════════════════════════════════════════════════════
// ENVIRONMENT SWITCHER
// ═════════════════════════════════════════════════════════

function applyEnvironment(env) {
    API_BASE_URL = env === 'dev' ? API_URL_DEV : API_URL_PROD;

    document.querySelectorAll('.env-btn[data-env]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.env === env);
    });
}

function switchEnvironment(env) {
    const currentEnv = localStorage.getItem(ENV_KEY) || 'prod';
    if (env === currentEnv) return;

    const envName = env === 'dev' ? 'DEVELOPMENT' : 'PRODUCTION';
    if (!confirm(`Switch to ${envName} environment? You will be logged out.`)) return;

    stopRefreshTimer();
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(TENANT_ID_KEY);
    currentToken = null;
    currentUser = null;

    localStorage.setItem(ENV_KEY, env);
    applyEnvironment(env);

    const surveyForm = document.getElementById('surveyForm');
    if (surveyForm) surveyForm.reset();
    const responseSection = document.getElementById('responseSection');
    if (responseSection) responseSection.style.display = 'none';

    document.getElementById('authSection').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    document.getElementById('authEmail').value = '';
    document.getElementById('authPassword').value = '';

    showToast(`Switched to ${envName}`, 'success');
}

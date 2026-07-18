// ─────────────────────────────────────────────────────────────────────────
// nav.js — CheckMyARM application shell: identity, active-session
// resolution, coarse platform guidance, and the universal Import/Run-Scan
// actions. Loaded by every page against a single <div id="app-shell"></div>
// placeholder, replacing what used to be a hand-written <nav> duplicated
// (with real divergence — see CLAUDE.md, Application Shell milestone) across
// ~13 pages.
//
// Deliberately excludes scoring/recommendation logic. computeSynthesis() and
// everything it depends on stays in assessment.js — this file never imports
// or calls into it, and never renders a score, confidence tier, or
// readiness label. The one exception (by design, not oversight) is the
// subtitle beneath the logo, which states raw evidence counts only
// (app/device totals already sitting on the loaded session's own results
// object) — never an interpretation of them. See CLAUDE.md, "the shell
// communicates context, the page communicates analysis."
//
// Self-contained on purpose: several pages that must load this file
// (Learn pages, admin pages) never load assessment.js at all, so the small
// amount of import-file validation logic needed for the universal "Import
// Assessment" action is duplicated here rather than shared — see the
// comment above sanitizeExportPayload() below for why that's the safer
// choice, not an oversight.
// ─────────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    // ─────────────────────────────────────
    //  Route → mode map, for active-page indication
    // ─────────────────────────────────────
    const ROUTE_MODE = {
        '/report.html': 'assessment',
        '/workspace.html': 'assessment',
        '/why.html': 'learn',
        '/how-it-thinks.html': 'learn',
        '/about.html': 'learn',
        '/my-submissions.html': 'account',
        '/admin-research.html': 'community',
        '/admin-revisit.html': 'community',
        '/admin-community-review.html': 'community',
        '/admin-dashboard.html': 'admin',
        '/admin-users.html': 'admin',
    };
    function currentMode() {
        return ROUTE_MODE[window.location.pathname] || null;
    }

    // ─────────────────────────────────────
    //  Import-file validation — a deliberate, self-contained duplicate of
    //  assessment.js's sanitizeExportPayload()/sanitizeImportedEntry() family.
    //  Import must work from ANY page (per the navigation architecture, it's
    //  always reachable from the Assessment menu), including pages that never
    //  load assessment.js at all (Learn pages, admin pages) — so this can't
    //  depend on that file being present. The logic here is pure validation
    //  (allowlists, type checks), never scoring, so duplicating it doesn't
    //  violate the shell/analysis separation — it just can't be *shared* via
    //  a direct reference without coupling this file's load order to
    //  assessment.js's, which would be a worse trade.
    // ─────────────────────────────────────
    const DECISION_VALUES = ['personally_verified', 'no_longer_use', 'waiting_for_vendor', 'doesnt_matter', 'research_note'];
    const VERIFIED_STATUS_VALUES = ['native', 'x64-emulated', 'x86-emulated', 'unsupported'];
    const CARRY_FORWARD_KEY = 'ngpcx_carry_forward_v1';
    const IMPORTED_ASSESSMENT_SNAPSHOT_KEY = 'ngpcx_imported_assessment_snapshot_v1';
    const SESSION_CONTEXT_PREFIX = 'ngpcx_session_context_'; // must match assessment.js's sessionContextKey()

    function sanitizeImportedEntry(raw) {
        if (!raw || typeof raw !== 'object' || typeof raw.app_name !== 'string' || !raw.app_name.trim()) return null;
        const decision = DECISION_VALUES.includes(raw.decision) ? raw.decision : 'research_note';
        const hasValidStatus = decision === 'personally_verified' && VERIFIED_STATUS_VALUES.includes(raw.verified_status);
        const safeDecision = (decision === 'personally_verified' && !hasValidStatus) ? 'research_note' : decision;
        return {
            app_name: raw.app_name.trim(),
            app_id: typeof raw.app_id === 'string' && raw.app_id.trim() ? raw.app_id.trim() : null,
            decision: safeDecision,
            verified_status: hasValidStatus ? raw.verified_status : undefined,
            critical_to_me: raw.critical_to_me === true,
            note: typeof raw.note === 'string' ? raw.note.slice(0, 2000) : '',
            researched_at: (typeof raw.researched_at === 'string' && !isNaN(Date.parse(raw.researched_at)))
                ? raw.researched_at : new Date().toISOString(),
            is_device: raw.is_device === true,
        };
    }

    function sanitizeObservationApp(raw) {
        if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
        const out = { name: raw.name.trim() };
        if (typeof raw.id === 'string' && raw.id.trim()) out.id = raw.id.trim();
        if (typeof raw.version === 'string') out.version = raw.version;
        if (typeof raw.publisher === 'string') out.publisher = raw.publisher;
        if (typeof raw.discovery_source === 'string') out.discovery_source = raw.discovery_source;
        for (const f of ['is_running', 'is_startup', 'has_start_menu_entry', 'is_pinned_taskbar', 'recently_used']) {
            if (typeof raw[f] === 'boolean') out[f] = raw[f];
        }
        for (const f of ['launch_count', 'days_since_last_launch', 'focus_count', 'focus_time_ms', 'default_handler_count']) {
            if (typeof raw[f] === 'number' && Number.isFinite(raw[f]) && raw[f] >= 0) out[f] = raw[f];
        }
        if (Array.isArray(raw.default_handler_categories)) {
            const cats = raw.default_handler_categories.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
            if (cats.length > 0) out.default_handler_categories = cats;
        }
        return out;
    }

    function sanitizeObservationDevice(raw) {
        if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
        const out = { name: raw.name.trim() };
        if (typeof raw.class === 'string') out.class = raw.class;
        if (typeof raw.hardware_id === 'string') out.hardware_id = raw.hardware_id;
        if (typeof raw.days_ago === 'number' && Number.isFinite(raw.days_ago) && raw.days_ago >= 0) out.days_ago = raw.days_ago;
        if (typeof raw.is_network === 'boolean') out.is_network = raw.is_network;
        if (typeof raw.manufacturer === 'string') out.manufacturer = raw.manufacturer;
        if (typeof raw.driver_service === 'string') out.driver_service = raw.driver_service;
        if (typeof raw.driver_provider === 'string') out.driver_provider = raw.driver_provider;
        return out;
    }

    function sanitizeExportPayload(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;

        if (typeof parsed.export_format_version === 'number') {
            const obs = parsed.observation_snapshot;
            const apps = Array.isArray(obs && obs.apps) ? obs.apps.map(sanitizeObservationApp).filter(Boolean) : [];
            const unlistedApps = Array.isArray(obs && obs.unlisted_apps) ? obs.unlisted_apps.map(sanitizeObservationApp).filter(Boolean) : [];
            const devices = Array.isArray(obs && obs.devices) ? obs.devices.map(sanitizeObservationDevice).filter(Boolean) : [];
            const entriesRaw = (parsed.personal_context && Array.isArray(parsed.personal_context.entries)) ? parsed.personal_context.entries : [];
            const entries = entriesRaw.map(sanitizeImportedEntry).filter(Boolean);
            if (apps.length === 0 && entries.length === 0) return null;
            return {
                formatVersion: parsed.export_format_version,
                scanMode: (obs && typeof obs.scan_mode === 'string') ? obs.scan_mode : null,
                scannerVersion: (obs && typeof obs.scanner_version === 'string') ? obs.scanner_version : null,
                apps, unlistedApps, devices, entries,
                assessmentSnapshot: (parsed.assessment_snapshot && typeof parsed.assessment_snapshot === 'object') ? parsed.assessment_snapshot : null,
            };
        }

        if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
            const entries = parsed.entries.map(sanitizeImportedEntry).filter(Boolean);
            if (entries.length === 0) return null;
            return { formatVersion: 0, scanMode: null, scannerVersion: null, apps: [], unlistedApps: [], devices: [], entries, assessmentSnapshot: null };
        }

        return null;
    }

    // ─────────────────────────────────────
    //  Coarse platform guidance — Windows / Non-Windows / Unknown only.
    //  Deliberately never CPU-architecture detection (Chromium-only, async,
    //  approximate, and its only real payoff — emphasizing ARM Optimization
    //  workflows — doesn't exist yet; see CLAUDE.md). Never sent to the
    //  server, never logged, never persisted — purely local, presentational,
    //  and only ever consulted when no assessment is loaded (see
    //  headerActions() below).
    // ─────────────────────────────────────
    function detectPlatform() {
        try {
            if (navigator.userAgentData && typeof navigator.userAgentData.platform === 'string' && navigator.userAgentData.platform) {
                return /windows/i.test(navigator.userAgentData.platform) ? 'windows' : 'nonwindows';
            }
        } catch (err) { /* fall through to legacy signals */ }
        const raw = (navigator.platform || '') + ' ' + (navigator.userAgent || '');
        if (/win/i.test(raw)) return 'windows';
        if (/mac|linux|android|iphone|ipad|cros/i.test(raw)) return 'nonwindows';
        return 'unknown';
    }

    // ─────────────────────────────────────
    //  Identity + active session
    // ─────────────────────────────────────
    async function loadAuthStatus() {
        try {
            const res = await fetch('/api/auth-status');
            return await res.json();
        } catch (err) {
            return { enabled: false, providers: {}, user: null };
        }
    }

    function roleRank(role) {
        return { user: 0, researcher: 1, admin: 2 }[role];
        // returns undefined for role === undefined/anonymous — callers use
        // (roleRank(role) >= N), and undefined >= N is always false, which is
        // exactly the "no access" behavior wanted, so no extra ?? needed.
    }

    // Single fetch/parse of /api/session/:id, shared by the one-shot check
    // below and the background poll in watchForSessionCompletion(). Returns
    // one of three outcomes rather than a plain session-or-null, because the
    // caller needs to tell "genuinely no session here" (404/410/network
    // error — stop looking) apart from "a real session that just isn't
    // finished yet" (status:'waiting' — worth checking again).
    async function fetchSession(sid) {
        try {
            const res = await fetch('/api/session/' + encodeURIComponent(sid));
            if (!res.ok) return { state: 'invalid' };
            const data = await res.json();
            if (data && data.status === 'complete') return { state: 'complete', results: data.results || null };
            return { state: 'waiting' };
        } catch (err) {
            return { state: 'invalid' };
        }
    }

    // Reads ?session= off the CURRENT page's own URL and checks it against
    // the server — a stale bookmark or an expired/never-finished session
    // must never be presented as "your assessment," so only a
    // status:'complete' session counts as valid here. This unifies what used
    // to be two different code paths (report.html/workspace.html already
    // knew their session synchronously; the five informational pages relied
    // on an async resolveActiveSession()/applySessionAwareNav() pair in
    // assessment.js) into the one mechanism every page now uses the same way.
    //
    // This is deliberately still a single check, not a poll — see
    // watchForSessionCompletion() below for why a still-waiting session
    // needs a second, separate mechanism rather than looping in here.
    async function resolveActiveSession() {
        const urlParams = new URLSearchParams(window.location.search);
        const sid = urlParams.get('session');
        if (!sid) return null;
        const level = urlParams.get('level') || '';
        const result = await fetchSession(sid);
        if (result.state !== 'complete') return null;
        return { sessionId: sid, level, results: result.results };
    }

    // Covers a real gap the one-shot check above can't: a session freshly
    // created right after "Run Scan" sits in status:'waiting' for anywhere
    // from seconds to well over a minute while the physical scanner runs on
    // the user's machine — report.html/workspace.html already poll this same
    // endpoint on a 1500ms interval to know when to leave their own loading
    // state, but nav.js previously checked exactly once, at page load. That
    // left the shell permanently believing "no assessment is active" for the
    // rest of that page view even after the underlying page finished and
    // showed a real report — the logo, subtitle, and Assessment menu never
    // recovered. Scoped to fire only when the URL actually names a session
    // the initial check couldn't yet resolve; a session-less page or an
    // already-resolved session never starts this poll.
    function watchForSessionCompletion(state) {
        const urlParams = new URLSearchParams(window.location.search);
        const sid = urlParams.get('session');
        if (!sid || state.session) return;
        const level = urlParams.get('level') || '';
        const intervalHandle = setInterval(async () => {
            const result = await fetchSession(sid);
            if (result.state === 'invalid') {
                clearInterval(intervalHandle);
                return;
            }
            if (result.state === 'complete') {
                clearInterval(intervalHandle);
                state.session = { sessionId: sid, level, results: result.results };
                render(state);
                decorateInfoLinks(state);
                window.NavShell.session = state.session;
            }
        }, 1500);
    }

    // ─────────────────────────────────────
    //  Unsaved-work safeguard for Run New Scan / Import — checked against
    //  sessionStorage directly (not an in-memory variable) so it works
    //  identically on every page regardless of whether that page's own
    //  script happens to track Personal Context live. Same storage key
    //  convention as assessment.js's sessionContextKey().
    // ─────────────────────────────────────
    function hasUnsavedWork(sessionId) {
        if (!sessionId) return false;
        try {
            const raw = sessionStorage.getItem(SESSION_CONTEXT_PREFIX + sessionId);
            if (!raw) return false;
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) && parsed.length > 0;
        } catch (err) {
            return false;
        }
    }

    function confirmReplaceIfNeeded(sessionId, actionLabel) {
        if (!hasUnsavedWork(sessionId)) return true;
        return window.confirm(
            "You've added personal notes or decisions to your current assessment.\n\n" +
            actionLabel + ' will start a new one — your current assessment will still exist, ' +
            "but you'll need this page's link to return to it.\n\nContinue?"
        );
    }

    // ─────────────────────────────────────
    //  URL builders
    // ─────────────────────────────────────
    function resultsHref(session) {
        return '/report.html?session=' + encodeURIComponent(session.sessionId) + '&level=' + encodeURIComponent(session.level || '') + '&origin=assessment';
    }
    function workspaceHref(session) {
        return '/workspace.html?session=' + encodeURIComponent(session.sessionId) + '&level=' + encodeURIComponent(session.level || '');
    }
    // The persistent Adaptive Assessment Surface (index.html) — the new
    // effective "home" once an assessment exists. See CLAUDE.md, Adaptive
    // Assessment Surface milestone. resultsHref() above still points at the
    // detailed report (report.html), unchanged in meaning — this is a
    // distinct, new destination, not a rename of it.
    function assessHref(session) {
        return '/?session=' + encodeURIComponent(session.sessionId) + '&level=' + encodeURIComponent(session.level || '');
    }

    // Carries the active session forward onto an otherwise plain internal
    // link — the same job assessment.js's old decorateInfoLinks() did for
    // the five informational pages, now applied uniformly by whichever menu
    // builds the link, so navigating Learn/Community/Account pages while an
    // assessment is loaded never silently drops it. No-op (plain path
    // unchanged) when no assessment is active.
    function withSession(path, state) {
        if (!state.session) return path;
        return path + '?session=' + encodeURIComponent(state.session.sessionId) + '&level=' + encodeURIComponent(state.session.level || '');
    }

    function isOnReportPage() { return !!document.getElementById('report'); }
    function isOnWorkspacePage() { return !!document.getElementById('workspace'); }

    // Applies the same session carry-forward to any in-body cross-link the
    // page marks with [data-info-link] (e.g. "See How CheckMyARM Thinks" from
    // inside About's own prose) — the body-content equivalent of what
    // withSession() does for menu items nav.js builds itself. Ports
    // assessment.js's old decorateInfoLinks(), called automatically from
    // init() below so pages never need to invoke it themselves.
    function decorateInfoLinks(state) {
        if (!state.session) return;
        document.querySelectorAll('[data-info-link]').forEach((a) => {
            const path = a.getAttribute('href').split('?')[0];
            a.href = withSession(path, state);
        });
    }

    // ─────────────────────────────────────
    //  Subtitle — raw evidence counts only, see file header.
    // ─────────────────────────────────────
    function subtitleText(session) {
        if (!session || !session.results) return 'Start or continue an assessment';
        const r = session.results;
        const appCount = ['native', 'emulated', 'unsupported', 'unknown'].reduce((n, b) => n + ((r[b] || []).length), 0) + ((r.systemComponents || []).length);
        const deviceCount = (r.devices || []).length;
        return 'Current assessment based on ' + appCount + ' app' + (appCount === 1 ? '' : 's') + ' · ' + deviceCount + ' device' + (deviceCount === 1 ? '' : 's');
    }

    // ─────────────────────────────────────
    //  Import / Run New Scan actions
    // ─────────────────────────────────────
    function triggerImport(state) {
        const currentSessionId = state.session && state.session.sessionId;
        if (!confirmReplaceIfNeeded(currentSessionId, 'Importing a new assessment')) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json';
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', async () => {
            const file = input.files[0];
            input.remove();
            if (!file) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                const importData = sanitizeExportPayload(parsed);
                if (!importData) throw new Error("This doesn't look like a CheckMyARM export file, or it has no saved notes.");

                const sessionRes = await fetch('/api/session', { method: 'POST' });
                const sessionData = await sessionRes.json();
                const newSessionId = sessionData.session_id;

                await fetch('/api/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        apps: importData.apps,
                        unlisted_apps: importData.unlistedApps,
                        devices: importData.devices,
                        session_id: newSessionId,
                        scan_mode: importData.scanMode || 'imported',
                        scanner_version: importData.scannerVersion || null,
                    }),
                });

                sessionStorage.setItem(CARRY_FORWARD_KEY, JSON.stringify({ entries: importData.entries, source: 'import' }));
                if (importData.assessmentSnapshot) {
                    sessionStorage.setItem(IMPORTED_ASSESSMENT_SNAPSHOT_KEY, JSON.stringify(importData.assessmentSnapshot));
                }
                window.location.href = '/?session=' + newSessionId + '&level=' + encodeURIComponent(importData.scanMode || 'imported') + '&carryForward=1';
            } catch (err) {
                alert('Import failed: ' + err.message);
            }
        });
        input.click();
    }

    function triggerNewScan(state) {
        const currentSessionId = state.session && state.session.sessionId;
        if (!confirmReplaceIfNeeded(currentSessionId, 'Starting a new scan')) return;
        window.location.href = '/';
    }

    function triggerExport(state) {
        if (typeof window.exportAssessment === 'function' && (isOnReportPage() || isOnWorkspacePage())) {
            window.exportAssessment();
        } else if (state.session) {
            window.location.href = resultsHref(state.session);
        }
    }

    function triggerPrint(state) {
        if (isOnReportPage()) {
            window.print();
        } else if (state.session) {
            window.location.href = resultsHref(state.session);
        }
    }

    // ─────────────────────────────────────
    //  Menu content builders — the single source of truth also driving the
    //  proposal's interactive matrix. See CLAUDE.md, Application Shell
    //  milestone, for the full identity x assessment-state table.
    // ─────────────────────────────────────
    function headerActions(state) {
        if (state.session) return null; // no standalone header actions once loaded — see Assessment menu
        if (state.platform === 'nonwindows') {
            return { primary: { label: 'Import Assessment', action: 'import' }, secondary: { label: 'Scan a Windows PC', action: 'scan' } };
        }
        return { primary: { label: 'Run New Scan', action: 'scan' }, secondary: { label: 'Import Assessment', action: 'import' } };
    }

    function buildAssessmentMenu(state) {
        if (!state.session) return null; // pre-assessment: actions live in the header instead
        return [
            { label: 'Assessment', href: assessHref(state.session) },
            { label: 'Detailed Report', href: resultsHref(state.session) },
            { label: 'Refine Assessment', href: workspaceHref(state.session) },
            { label: 'Export', action: 'export' },
            { label: 'Print', action: 'print' },
            { label: 'Run Another Scan', action: 'scan' },
            { label: 'Import Another Assessment', action: 'import' },
        ];
    }

    function buildCommunityMenu(state) {
        const rank = roleRank(state.auth.user && state.auth.user.role);
        if (!(rank >= 1)) return null; // hidden below researcher rank — no dedicated content for ordinary users today
        return [
            { label: 'Research Unknown Apps', href: '/admin-research.html' },
            { label: 'Revisit Verdicts', href: '/admin-revisit.html' },
            { label: 'Community Review', href: '/admin-community-review.html' },
        ];
    }

    function buildLearnMenu(state) {
        return [
            { label: 'Why CheckMyARM', href: withSession('/why.html', state) },
            { label: 'How CheckMyARM Thinks', href: withSession('/how-it-thinks.html', state) },
            { label: 'About', href: withSession('/about.html', state) },
        ];
    }

    function buildAdminMenu(state) {
        if (!(state.auth.user && state.auth.user.role === 'admin')) return null;
        return [
            { label: 'Dashboard', href: '/admin-dashboard.html' },
            { label: 'Manage Users', href: '/admin-users.html' },
        ];
    }

    // ─────────────────────────────────────
    //  Rendering
    // ─────────────────────────────────────
    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function logoHref(state) {
        return state.session ? assessHref(state.session) : '/';
    }

    // The ™ mark is deliberately sparse sitewide (see CLAUDE.md, Branding —
    // "the two 'first prominent reference' spots") — the homepage nav logo is
    // one of exactly two places it appears, the other being about.html's own
    // body copy (untouched by the shell). Every other page's logo stays plain.
    // Admin pages keep their own distinct wordmark split (CheckMyARM+Admin,
    // vs. CheckMy+ARM everywhere else) — a pre-existing branding distinction,
    // not something this shell introduces.
    function logoMarkup() {
        if (window.location.pathname.startsWith('/admin-')) {
            return `<img src="/logo-64.png" alt="CheckMyARM logo">CheckMyARM<span>Admin</span>`;
        }
        const tm = window.location.pathname === '/' ? '<span class="tm">™</span>' : '';
        return `<img src="/logo-64.png" alt="CheckMyARM logo">CheckMy<span>ARM</span>${tm}`;
    }

    function actionItemHtml(item, extraClass) {
        // Action items (export/print/scan/import) are real <a href="#"> so
        // they remain keyboard-reachable and behave like every other menu
        // entry; the click handler intercepts navigation.
        return `<a href="#" class="shell-menu-item ${extraClass || ''}" data-action="${item.action}" role="menuitem">${escapeHtml(item.label)}</a>`;
    }
    function linkItemHtml(item) {
        return `<a href="${item.href}" class="shell-menu-item" role="menuitem">${escapeHtml(item.label)}</a>`;
    }
    function menuItemHtml(item) {
        return item.action ? actionItemHtml(item) : linkItemHtml(item);
    }

    function dropdownHtml(id, label, items, mode) {
        if (!items) return '';
        const active = currentMode() === mode ? ' shell-mode-active' : '';
        return `
      <div class="shell-dropdown">
        <button type="button" class="shell-mode-btn${active}" aria-haspopup="true" aria-expanded="false" data-dropdown="${id}">
          ${escapeHtml(label)} <span class="shell-caret">▾</span>
        </button>
        <div class="shell-dropdown-panel" id="dd-${id}" role="menu" hidden>
          ${items.map(menuItemHtml).join('')}
        </div>
      </div>`;
    }

    function accountClusterHtml(state) {
        const user = state.auth.user;
        if (!user) {
            if (!state.auth.enabled) return '';
            const returnParam = state.session ? ('?return=' + encodeURIComponent(state.session.sessionId)) : '';
            const providers = [];
            if (state.auth.providers && state.auth.providers.google) providers.push(`<a href="/auth/google${returnParam}" class="shell-menu-item" role="menuitem">Sign in with Google</a>`);
            if (state.auth.providers && state.auth.providers.github) providers.push(`<a href="/auth/github${returnParam}" class="shell-menu-item" role="menuitem">Sign in with GitHub</a>`);
            if (providers.length === 0) return '';
            return `
        <div class="shell-dropdown">
          <button type="button" class="shell-signin-btn" aria-haspopup="true" aria-expanded="false" data-dropdown="signin">Sign In <span class="shell-caret">▾</span></button>
          <div class="shell-dropdown-panel shell-dropdown-panel-right" id="dd-signin" role="menu" hidden>${providers.join('')}</div>
        </div>`;
        }
        const initials = (user.displayName || 'U').trim().charAt(0).toUpperCase() || 'U';
        const roleBadge = user.role !== 'user' ? `<span class="shell-role-badge shell-role-${user.role}">${user.role}</span>` : '';
        const active = currentMode() === 'account' ? ' shell-mode-active' : '';
        return `
      <div class="shell-dropdown">
        <button type="button" class="shell-account-btn${active}" aria-haspopup="true" aria-expanded="false" data-dropdown="account">
          <span class="shell-avatar">${escapeHtml(initials)}</span>
          <span class="shell-account-name">${escapeHtml(user.displayName || 'Signed in')}</span>
          ${roleBadge}
          <span class="shell-caret">▾</span>
        </button>
        <div class="shell-dropdown-panel shell-dropdown-panel-right" id="dd-account" role="menu" hidden>
          <a href="${withSession('/my-submissions.html', state)}" class="shell-menu-item" role="menuitem">My Contributions</a>
          <a href="/auth/logout" class="shell-menu-item" role="menuitem">Log out</a>
        </div>
      </div>`;
    }

    function headerActionsHtml(state) {
        const actions = headerActions(state);
        if (!actions) return '';
        return `
      <a href="#" class="shell-cta shell-cta-secondary" data-action="${actions.secondary.action}">${escapeHtml(actions.secondary.label)}</a>
      <a href="#" class="shell-cta shell-cta-primary" data-action="${actions.primary.action}">${escapeHtml(actions.primary.label)}</a>`;
    }

    function desktopNavHtml(state) {
        const assessmentItems = buildAssessmentMenu(state);
        const communityItems = buildCommunityMenu(state);
        const learnItems = buildLearnMenu(state);
        const adminItems = buildAdminMenu(state);
        const activeAssessment = currentMode() === 'assessment' ? ' shell-mode-active' : '';

        return `
      <div class="shell-brand">
        <a href="${logoHref(state)}" class="shell-logo-link">
          <div class="shell-logo">${logoMarkup()}</div>
        </a>
        <div class="shell-subtitle">${escapeHtml(subtitleText(state.session))}</div>
      </div>
      <nav class="shell-desktop-menus" aria-label="Primary">
        ${assessmentItems
                ? dropdownHtml('assessment', 'Assessment', assessmentItems, 'assessment')
                : `<span class="shell-mode-btn shell-mode-static${activeAssessment}">Assessment</span>`}
        ${dropdownHtml('community', 'Community', communityItems, 'community')}
        ${dropdownHtml('learn', 'Learn', learnItems, 'learn')}
        ${dropdownHtml('admin', 'Administration', adminItems, 'admin')}
      </nav>
      <div class="shell-desktop-right">
        ${headerActionsHtml(state)}
        ${accountClusterHtml(state)}
      </div>
      <button type="button" class="shell-hamburger" aria-label="Toggle navigation menu" aria-expanded="false" aria-controls="shell-mobile-panel">
        <span></span><span></span><span></span>
      </button>`;
    }

    function accordionHtml(id, label, items, mode, emptyNote) {
        if (!items) {
            if (!emptyNote) return '';
            return `<div class="shell-accordion"><div class="shell-accordion-empty">${escapeHtml(emptyNote)}</div></div>`;
        }
        const active = currentMode() === mode ? ' shell-mode-active' : '';
        return `
      <div class="shell-accordion">
        <button type="button" class="shell-accordion-head${active}" data-accordion="${id}" aria-expanded="false">
          ${escapeHtml(label)} <span class="shell-caret">▸</span>
        </button>
        <div class="shell-accordion-body" id="acc-${id}" hidden>
          ${items.map(menuItemHtml).join('')}
        </div>
      </div>`;
    }

    function mobilePanelHtml(state) {
        const user = state.auth.user;
        const assessmentItems = buildAssessmentMenu(state);
        const communityItems = buildCommunityMenu(state);
        const learnItems = buildLearnMenu(state);
        const adminItems = buildAdminMenu(state);

        let identityHtml;
        if (user) {
            const initials = (user.displayName || 'U').trim().charAt(0).toUpperCase() || 'U';
            const roleBadge = user.role !== 'user' ? `<span class="shell-role-badge shell-role-${user.role}">${user.role}</span>` : '';
            identityHtml = `<div class="shell-mobile-identity"><span class="shell-avatar">${escapeHtml(initials)}</span> ${escapeHtml(user.displayName || 'Signed in')} ${roleBadge}</div>`;
        } else if (state.auth.enabled) {
            const returnParam = state.session ? ('?return=' + encodeURIComponent(state.session.sessionId)) : '';
            const providers = [];
            if (state.auth.providers && state.auth.providers.google) providers.push(`<a href="/auth/google${returnParam}" class="shell-menu-item">Sign in with Google</a>`);
            if (state.auth.providers && state.auth.providers.github) providers.push(`<a href="/auth/github${returnParam}" class="shell-menu-item">Sign in with GitHub</a>`);
            identityHtml = `<div class="shell-mobile-identity">Not signed in</div>${providers.join('')}`;
        } else {
            identityHtml = '';
        }

        return `
      <div class="shell-mobile-subtitle">${escapeHtml(subtitleText(state.session))}</div>
      ${identityHtml}
      ${headerActions(state) ? `<div class="shell-mobile-cta-row">${headerActionsHtml(state)}</div>` : ''}
      ${accordionHtml('m-assessment', 'Assessment', assessmentItems, 'assessment', null)}
      ${accordionHtml('m-community', 'Community', communityItems, 'community', null)}
      ${accordionHtml('m-learn', 'Learn', learnItems, 'learn', null)}
      ${user ? `${accordionHtml('m-account', 'My Account', [{ label: 'My Contributions', href: withSession('/my-submissions.html', state) }, { label: 'Log out', href: '/auth/logout' }], 'account', null)}` : ''}
      ${accordionHtml('m-admin', 'Administration', adminItems, 'admin', null)}`;
    }

    function render(state) {
        const root = document.getElementById('app-shell');
        if (!root) return;
        root.innerHTML = `
      <nav class="shell-nav">
        <div class="shell-desktop-row">${desktopNavHtml(state)}</div>
      </nav>
      <div class="shell-mobile-panel" id="shell-mobile-panel" hidden>${mobilePanelHtml(state)}</div>
    `;
        wireInteractions(root, state);
    }

    // ─────────────────────────────────────
    //  Interaction wiring — dropdown open/close, hamburger, keyboard
    //  dismissal (Escape), click-outside dismissal, and the action items
    //  (export/print/scan/import).
    // ─────────────────────────────────────
    function closeAllDropdowns(root) {
        root.querySelectorAll('.shell-dropdown-panel').forEach((p) => { p.hidden = true; });
        root.querySelectorAll('[data-dropdown]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }

    function closeMobilePanel(root) {
        const panel = document.getElementById('shell-mobile-panel');
        if (panel) panel.hidden = true;
        const burger = root.querySelector('.shell-hamburger');
        if (burger) burger.setAttribute('aria-expanded', 'false');
        root.querySelectorAll('.shell-accordion-body').forEach((b) => { b.hidden = true; });
        root.querySelectorAll('[data-accordion]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    }

    function handleAction(action, state) {
        if (action === 'scan') triggerNewScan(state);
        else if (action === 'import') triggerImport(state);
        else if (action === 'export') triggerExport(state);
        else if (action === 'print') triggerPrint(state);
    }

    function wireInteractions(root, state) {
        // Desktop dropdown toggles
        root.querySelectorAll('[data-dropdown]').forEach((btn) => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = btn.dataset.dropdown;
                const panel = document.getElementById('dd-' + id);
                const isOpen = panel && !panel.hidden;
                closeAllDropdowns(root);
                if (panel && !isOpen) {
                    panel.hidden = false;
                    btn.setAttribute('aria-expanded', 'true');
                }
            });
        });

        // Mobile accordion toggles
        root.querySelectorAll('[data-accordion]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.accordion;
                const body = document.getElementById('acc-' + id);
                if (!body) return;
                const willOpen = body.hidden;
                body.hidden = !willOpen;
                btn.setAttribute('aria-expanded', String(willOpen));
            });
        });

        // Hamburger
        const burger = root.querySelector('.shell-hamburger');
        if (burger) {
            burger.addEventListener('click', () => {
                const panel = document.getElementById('shell-mobile-panel');
                if (!panel) return;
                const willOpen = panel.hidden;
                if (willOpen) {
                    closeAllDropdowns(root);
                    panel.hidden = false;
                    burger.setAttribute('aria-expanded', 'true');
                } else {
                    closeMobilePanel(root);
                }
            });
        }

        // Action items (both desktop dropdown and mobile panel share data-action)
        root.querySelectorAll('[data-action]').forEach((el) => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                closeAllDropdowns(root);
                closeMobilePanel(root);
                handleAction(el.dataset.action, state);
            });
        });

        // Any plain link click inside the mobile panel should close it before
        // navigating, so a bfcache-restored back-navigation doesn't show a
        // stale open panel.
        root.querySelectorAll('#shell-mobile-panel a[href]:not([data-action])').forEach((a) => {
            a.addEventListener('click', () => closeMobilePanel(root));
        });
    }

    // Click-outside and Escape dismissal are wired once, not inside
    // wireInteractions() — render() can now run a second time (see
    // watchForSessionCompletion() above), and wireInteractions() itself is
    // meant to be re-run each time to reattach listeners onto the freshly
    // replaced dropdown/accordion nodes, but these two only ever need to
    // exist once: `root` is the stable #app-shell container whose innerHTML
    // gets replaced, never the container itself, so a listener attached to
    // it once keeps working correctly across every future re-render.
    function wireGlobalDismissal(root) {
        document.addEventListener('click', (e) => {
            if (!root.contains(e.target)) { closeAllDropdowns(root); }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeAllDropdowns(root);
                closeMobilePanel(root);
            }
        });
    }

    // ─────────────────────────────────────
    //  Init
    // ─────────────────────────────────────
    async function init() {
        const [auth, session] = await Promise.all([loadAuthStatus(), resolveActiveSession()]);
        const state = { auth, session, platform: detectPlatform() };
        render(state);
        wireGlobalDismissal(document.getElementById('app-shell'));
        decorateInfoLinks(state);
        // triggerImport is exposed so page-specific body copy (e.g. index.html's
        // "Already started? Import your saved Workspace" hero prompt) can reuse
        // the one universal import mechanism instead of a second implementation.
        window.NavShell = { auth: auth, session: session, ready: true, triggerImport: () => triggerImport(state) };
        document.dispatchEvent(new CustomEvent('navshell:ready', { detail: state }));
        watchForSessionCompletion(state);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

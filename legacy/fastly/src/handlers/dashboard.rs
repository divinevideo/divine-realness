// ABOUTME: Dashboard UI handler serving single-page HTML interface
// ABOUTME: Provides event submission, job list, provider comparison grid with auto-refresh

use fastly::{Error, Request, Response};

pub fn handle(_req: Request) -> Result<Response, Error> {
    let html = generate_dashboard_html();
    Ok(Response::from_status(200)
        .with_header("Content-Type", "text/html; charset=utf-8")
        .with_body(html))
}

fn generate_dashboard_html() -> String {
    r#"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nostr AI Video Detector</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            color: #e0e0e0;
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        header {
            text-align: center;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: 2px solid #8b5cf6;
        }

        h1 {
            font-size: 2.5rem;
            color: #8b5cf6;
            margin-bottom: 10px;
            text-shadow: 0 0 20px rgba(139, 92, 246, 0.3);
        }

        .subtitle {
            color: #a0a0a0;
            font-size: 1rem;
        }

        .submit-section {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 30px;
            margin-bottom: 40px;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(139, 92, 246, 0.2);
        }

        .input-group {
            display: flex;
            gap: 12px;
            margin-bottom: 10px;
        }

        input[type="text"] {
            flex: 1;
            padding: 14px 18px;
            background: rgba(0, 0, 0, 0.3);
            border: 2px solid rgba(139, 92, 246, 0.3);
            border-radius: 8px;
            color: #e0e0e0;
            font-size: 1rem;
            transition: all 0.3s ease;
        }

        input[type="text"]:focus {
            outline: none;
            border-color: #8b5cf6;
            box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.1);
        }

        input[type="text"]::placeholder {
            color: #666;
        }

        button {
            padding: 14px 32px;
            background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
            border: none;
            border-radius: 8px;
            color: white;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 15px rgba(139, 92, 246, 0.3);
        }

        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 6px 20px rgba(139, 92, 246, 0.4);
        }

        button:active {
            transform: translateY(0);
        }

        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }

        .help-text {
            color: #888;
            font-size: 0.875rem;
            margin-top: 8px;
        }

        .jobs-section {
            margin-bottom: 40px;
        }

        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }

        h2 {
            font-size: 1.5rem;
            color: #e0e0e0;
        }

        .refresh-indicator {
            color: #8b5cf6;
            font-size: 0.875rem;
            opacity: 0;
            transition: opacity 0.3s ease;
        }

        .refresh-indicator.active {
            opacity: 1;
        }

        .job-card {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            border: 1px solid rgba(139, 92, 246, 0.2);
            transition: all 0.3s ease;
        }

        .job-card:hover {
            border-color: rgba(139, 92, 246, 0.4);
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
        }

        .job-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
            flex-wrap: wrap;
            gap: 12px;
        }

        .job-id {
            font-family: monospace;
            color: #8b5cf6;
            font-size: 0.9rem;
        }

        .job-status {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 0.75rem;
            font-weight: 600;
            text-transform: uppercase;
        }

        .status-pending {
            background: rgba(234, 179, 8, 0.2);
            color: #fbbf24;
        }

        .status-completed {
            background: rgba(34, 197, 94, 0.2);
            color: #4ade80;
        }

        .status-failed {
            background: rgba(239, 68, 68, 0.2);
            color: #f87171;
        }

        .provider-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 16px;
            margin-bottom: 16px;
        }

        .provider-card {
            background: rgba(0, 0, 0, 0.3);
            border-radius: 8px;
            padding: 16px;
            border: 2px solid transparent;
            transition: all 0.3s ease;
        }

        .provider-card.score-low {
            border-color: rgba(34, 197, 94, 0.5);
        }

        .provider-card.score-medium {
            border-color: rgba(234, 179, 8, 0.5);
        }

        .provider-card.score-high {
            border-color: rgba(239, 68, 68, 0.5);
        }

        .provider-name {
            font-weight: 600;
            margin-bottom: 12px;
            color: #e0e0e0;
            font-size: 1rem;
        }

        .provider-score {
            font-size: 2rem;
            font-weight: 700;
            margin-bottom: 8px;
        }

        .score-low .provider-score {
            color: #4ade80;
        }

        .score-medium .provider-score {
            color: #fbbf24;
        }

        .score-high .provider-score {
            color: #f87171;
        }

        .provider-verdict {
            font-size: 0.875rem;
            color: #a0a0a0;
            margin-bottom: 8px;
        }

        .provider-status {
            font-size: 0.75rem;
            padding: 4px 8px;
            border-radius: 4px;
            display: inline-block;
            margin-top: 8px;
        }

        .provider-status.pending {
            background: rgba(234, 179, 8, 0.2);
            color: #fbbf24;
        }

        .provider-status.completed {
            background: rgba(34, 197, 94, 0.2);
            color: #4ade80;
        }

        .expand-toggle {
            background: rgba(139, 92, 246, 0.2);
            border: 1px solid rgba(139, 92, 246, 0.3);
            padding: 8px 16px;
            border-radius: 6px;
            color: #8b5cf6;
            font-size: 0.875rem;
            cursor: pointer;
            transition: all 0.3s ease;
        }

        .expand-toggle:hover {
            background: rgba(139, 92, 246, 0.3);
        }

        .raw-response {
            margin-top: 16px;
            background: rgba(0, 0, 0, 0.5);
            border-radius: 8px;
            padding: 16px;
            border-left: 3px solid #8b5cf6;
            display: none;
        }

        .raw-response.expanded {
            display: block;
        }

        .raw-response pre {
            color: #a0a0a0;
            font-size: 0.75rem;
            overflow-x: auto;
            white-space: pre-wrap;
            word-wrap: break-word;
        }

        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #666;
        }

        .empty-state svg {
            width: 64px;
            height: 64px;
            margin-bottom: 16px;
            opacity: 0.3;
        }

        .error-message {
            background: rgba(239, 68, 68, 0.1);
            border: 1px solid rgba(239, 68, 68, 0.3);
            color: #f87171;
            padding: 12px 16px;
            border-radius: 8px;
            margin-top: 12px;
            display: none;
        }

        .error-message.visible {
            display: block;
        }

        @media (max-width: 768px) {
            h1 {
                font-size: 1.75rem;
            }

            .input-group {
                flex-direction: column;
            }

            .provider-grid {
                grid-template-columns: 1fr;
            }

            .job-header {
                flex-direction: column;
                align-items: flex-start;
            }
        }

        .timestamp {
            color: #666;
            font-size: 0.75rem;
            margin-top: 4px;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>⚡ Nostr AI Video Detector</h1>
            <p class="subtitle">Multi-provider deepfake detection for Nostr video events</p>
        </header>

        <div class="submit-section">
            <div class="input-group">
                <input
                    type="text"
                    id="eventInput"
                    placeholder="nevent1... or hex event ID"
                    aria-label="Nostr event ID"
                />
                <button id="submitBtn" onclick="submitEvent()">Analyze Event</button>
            </div>
            <p class="help-text">Enter a Nostr event ID (nevent1... or 64-char hex) to analyze the video for AI-generated content</p>
            <div id="errorMessage" class="error-message"></div>
        </div>

        <div class="jobs-section">
            <div class="section-header">
                <h2>Analysis Jobs</h2>
                <span id="refreshIndicator" class="refresh-indicator">Refreshing...</span>
            </div>
            <div id="jobsList"></div>
        </div>
    </div>

    <script>
        let autoRefreshInterval = null;

        // Bech32 decoding for nevent/note IDs (NIP-19)
        const BECH32_ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

        function bech32Decode(str) {
            str = str.toLowerCase();
            const sepIdx = str.lastIndexOf('1');
            if (sepIdx < 1) throw new Error('Invalid bech32: no separator');

            const hrp = str.slice(0, sepIdx);
            const dataStr = str.slice(sepIdx + 1);

            const data = [];
            for (const c of dataStr) {
                const idx = BECH32_ALPHABET.indexOf(c);
                if (idx === -1) throw new Error('Invalid bech32 character');
                data.push(idx);
            }

            // Remove checksum (last 6 chars)
            const values = data.slice(0, -6);

            // Convert 5-bit groups to 8-bit bytes
            let acc = 0;
            let bits = 0;
            const bytes = [];
            for (const v of values) {
                acc = (acc << 5) | v;
                bits += 5;
                while (bits >= 8) {
                    bits -= 8;
                    bytes.push((acc >> bits) & 0xff);
                }
            }

            return { hrp, bytes: new Uint8Array(bytes) };
        }

        function decodeNevent(nevent) {
            const { hrp, bytes } = bech32Decode(nevent);
            if (hrp !== 'nevent' && hrp !== 'note') {
                throw new Error('Invalid prefix: expected nevent or note');
            }

            if (hrp === 'note') {
                // note1 directly encodes 32-byte event ID
                return Array.from(bytes.slice(0, 32))
                    .map(b => b.toString(16).padStart(2, '0'))
                    .join('');
            }

            // nevent uses TLV encoding - find type 0 (event ID)
            let i = 0;
            while (i < bytes.length) {
                const type = bytes[i];
                const len = bytes[i + 1];
                if (type === 0 && len === 32) {
                    // Found event ID
                    return Array.from(bytes.slice(i + 2, i + 2 + 32))
                        .map(b => b.toString(16).padStart(2, '0'))
                        .join('');
                }
                i += 2 + len;
            }
            throw new Error('No event ID found in nevent');
        }

        async function submitEvent() {
            const input = document.getElementById('eventInput');
            const eventId = input.value.trim();
            const submitBtn = document.getElementById('submitBtn');
            const errorMsg = document.getElementById('errorMessage');

            errorMsg.classList.remove('visible');

            if (!eventId) {
                showError('Please enter a Nostr event ID');
                return;
            }

            // Accept nevent1..., note1..., or 64-char hex event IDs
            const isNevent = eventId.startsWith('nevent1') || eventId.startsWith('note1');
            const isHexId = /^[0-9a-fA-F]{64}$/.test(eventId);
            if (!isNevent && !isHexId) {
                showError('Event ID must be nevent1..., note1..., or 64-char hex');
                return;
            }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Fetching event...';

            try {
                // Decode bech32 event ID to hex if needed (gateway expects hex)
                let hexEventId = eventId;
                console.log('[DEBUG] Input eventId:', eventId);
                console.log('[DEBUG] isNevent:', isNevent);

                if (isNevent) {
                    try {
                        hexEventId = decodeNevent(eventId);
                        console.log('[DEBUG] Decoded to hex:', hexEventId);
                    } catch (e) {
                        console.error('[DEBUG] Decode error:', e);
                        throw new Error('Failed to decode event ID: ' + e.message);
                    }
                }

                // Fetch event from REST gateway (browser can access this directly)
                const gatewayUrl = `https://cleanly-resolved-tetra.edgecompute.app/event/${hexEventId}`;
                console.log('[DEBUG] Gateway URL:', gatewayUrl);

                const eventResp = await fetch(gatewayUrl);
                console.log('[DEBUG] Gateway response status:', eventResp.status);

                if (!eventResp.ok) {
                    throw new Error('Failed to fetch event from relay');
                }
                const data = await eventResp.json();
                console.log('[DEBUG] Gateway response:', JSON.stringify(data).substring(0, 500));

                if (!data.events || data.events.length === 0) {
                    throw new Error('Event not found');
                }
                const event = data.events[0];

                // Parse imeta tags to extract video URL
                const imetaTag = event.tags.find(t => t[0] === 'imeta');
                console.log('[DEBUG] imeta tag:', JSON.stringify(imetaTag));
                if (!imetaTag) {
                    throw new Error('No video metadata found in event');
                }

                // Parse imeta tag fields - supports two formats:
                // Format 1 (NIP-94 style): ["imeta", "url https://...", "m video/mp4"]
                // Format 2 (NIP-71 style): ["imeta", "url", "https://...", "m", "video/mp4"]
                let videoUrl = null;
                let mediaHash = null;
                for (let i = 1; i < imetaTag.length; i++) {
                    const part = imetaTag[i];
                    // Format 1: combined "key value"
                    if (part.startsWith('url ')) {
                        videoUrl = part.substring(4);
                    } else if (part.startsWith('x ')) {
                        mediaHash = part.substring(2);
                    }
                    // Format 2: separate key/value pairs
                    else if (part === 'url' && i + 1 < imetaTag.length) {
                        videoUrl = imetaTag[i + 1];
                    } else if (part === 'x' && i + 1 < imetaTag.length) {
                        mediaHash = imetaTag[i + 1];
                    }
                }

                console.log('[DEBUG] Parsed videoUrl:', videoUrl);
                console.log('[DEBUG] Parsed mediaHash:', mediaHash);
                if (!videoUrl) {
                    throw new Error('No video URL found in event metadata');
                }

                submitBtn.textContent = 'Analyzing...';

                // Submit to backend with video URL
                const response = await fetch('/analyze', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        eventId: eventId,
                        videoUrl: videoUrl,
                        mediaHash: mediaHash
                    }),
                });

                if (!response.ok) {
                    const error = await response.text();
                    throw new Error(error || 'Failed to submit event');
                }

                input.value = '';
                await loadJobs();
                startAutoRefresh();
            } catch (error) {
                showError(error.message);
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Analyze Event';
            }
        }

        function showError(message) {
            const errorMsg = document.getElementById('errorMessage');
            errorMsg.textContent = message;
            errorMsg.classList.add('visible');
        }

        async function loadJobs() {
            const indicator = document.getElementById('refreshIndicator');
            indicator.classList.add('active');

            try {
                const response = await fetch('/api/jobs');
                if (!response.ok) {
                    throw new Error('Failed to load jobs');
                }

                const data = await response.json();
                const jobs = data.jobs || [];
                renderJobs(jobs);

                // Auto-refresh if there are pending jobs
                const hasPending = jobs.some(job => job.status === 'pending');
                if (hasPending && !autoRefreshInterval) {
                    startAutoRefresh();
                } else if (!hasPending && autoRefreshInterval) {
                    stopAutoRefresh();
                }
            } catch (error) {
                console.error('Error loading jobs:', error);
            } finally {
                setTimeout(() => {
                    indicator.classList.remove('active');
                }, 300);
            }
        }

        function renderJobs(jobs) {
            const jobsList = document.getElementById('jobsList');

            if (!jobs || jobs.length === 0) {
                jobsList.innerHTML = `
                    <div class="empty-state">
                        <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path>
                        </svg>
                        <p>No analysis jobs yet. Submit a Nostr event to get started.</p>
                    </div>
                `;
                return;
            }

            jobsList.innerHTML = jobs.map(job => renderJobCard(job)).join('');
        }

        function renderJobCard(job) {
            // Map 'complete' to 'completed' for CSS class
            const statusText = job.status === 'complete' ? 'completed' : job.status;
            const statusClass = `status-${statusText}`;
            const timestamp = new Date(job.submitted).toLocaleString();

            return `
                <div class="job-card">
                    <div class="job-header">
                        <div>
                            <div class="job-id">${job.event_id}</div>
                            <div class="timestamp">${timestamp}</div>
                        </div>
                        <span class="job-status ${statusClass}">${statusText}</span>
                    </div>

                    <div class="provider-grid">
                        ${renderProviderCard('Reality Defender', job.results?.reality_defender)}
                        ${renderProviderCard('HiveAI', job.results?.hive)}
                        ${renderProviderCard('Sensity', job.results?.sensity)}
                    </div>

                    <button class="expand-toggle" onclick="toggleRawResponse('${job.event_id}')">
                        Show Raw Response
                    </button>
                    <div id="raw-${job.event_id}" class="raw-response">
                        <pre>${JSON.stringify(job, null, 2)}</pre>
                    </div>
                </div>
            `;
        }

        function renderProviderCard(name, provider) {
            if (!provider || provider.status === 'pending') {
                return `
                    <div class="provider-card">
                        <div class="provider-name">${name}</div>
                        <div class="provider-status pending">Pending</div>
                    </div>
                `;
            }

            if (provider.status === 'error') {
                return `
                    <div class="provider-card">
                        <div class="provider-name">${name}</div>
                        <div class="provider-status" style="background: rgba(239, 68, 68, 0.2); color: #f87171;">Error</div>
                        <div style="font-size: 0.75rem; color: #f87171; margin-top: 8px;">${provider.error || 'Unknown error'}</div>
                    </div>
                `;
            }

            // Score is 0-1, convert to percentage
            const rawScore = provider.score || 0;
            const scorePercent = rawScore * 100;
            const scoreClass = scorePercent < 30 ? 'score-low' : scorePercent < 70 ? 'score-medium' : 'score-high';

            return `
                <div class="provider-card ${scoreClass}">
                    <div class="provider-name">${name}</div>
                    <div class="provider-score">${scorePercent.toFixed(1)}%</div>
                    <div class="provider-verdict">${provider.verdict || 'Unknown'}</div>
                    <div class="provider-status completed">Completed</div>
                </div>
            `;
        }

        function toggleRawResponse(jobId) {
            const element = document.getElementById(`raw-${jobId}`);
            element.classList.toggle('expanded');

            const button = element.previousElementSibling;
            button.textContent = element.classList.contains('expanded')
                ? 'Hide Raw Response'
                : 'Show Raw Response';
        }

        function startAutoRefresh() {
            if (autoRefreshInterval) return;
            autoRefreshInterval = setInterval(loadJobs, 5000);
        }

        function stopAutoRefresh() {
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }
        }

        // Handle Enter key in input field
        document.getElementById('eventInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                submitEvent();
            }
        });

        // Initial load
        loadJobs();

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => {
            stopAutoRefresh();
        });
    </script>
</body>
</html>"#.to_string()
}

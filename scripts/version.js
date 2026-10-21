const CHANGELOG_ENTRY_LIMIT = 10;
const CHANGELOG_MORE_URL = "https://github.com/paddysdreamland/Website/tree/Release";
const CLAUDE_PROFILE_URL = "https://github.com/claude";

function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    }[c]));
}

function renderBody(body) {
    const rawLines = body.split("\n");

    let html = "";
    let bulletBuffer = [];
    let paragraphBuffer = [];

    const flushBullets = () => {
        if (bulletBuffer.length) {
            html += `<ul class="changelog-bullets">${bulletBuffer.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>`;
            bulletBuffer = [];
        }
    };

    const flushParagraph = () => {
        if (paragraphBuffer.length) {
            html += `<p class="changelog-text">${escapeHtml(paragraphBuffer.join(" "))}</p>`;
            paragraphBuffer = [];
        }
    };

    for (const rawLine of rawLines) {
        const line = rawLine.trim();

        if (!line) {
            // A blank line ends whichever block (paragraph or bullet list) is currently open.
            flushBullets();
            flushParagraph();
            continue;
        }

        const bulletMatch = line.match(/^[-*•]\s+(.*)/);
        if (bulletMatch) {
            flushParagraph();
            bulletBuffer.push(bulletMatch[1]);
        } else {
            flushBullets();
            paragraphBuffer.push(line);
        }
    }
    flushBullets();
    flushParagraph();

    return html;
}

function profileLink(name, url) {
    // Only GitHub profile links are turned into links, anything else stays plain text.
    if (url && url.startsWith("https://github.com/")) {
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`;
    }
    return escapeHtml(name);
}

// "— Paddy-V", or "— Claude with Paddy-V" for commits made together with Claude.
function renderSignature(entry) {
    if (!entry.author || !entry.author.name) return "";
    const person = profileLink(entry.author.name, entry.author.url);
    const claude = entry.claude ? `${profileLink("Claude", CLAUDE_PROFILE_URL)} with ` : "";
    return `<p class="section-signature">— ${claude}${person}</p>`;
}

fetch("/version.json")
    .then((res) => res.json())
    .then((data) => {
        const el = document.getElementById("git-version");
        if (el) el.textContent = data.version;
    })
    .catch((err) => console.error("Failed to load version.json", err));

const changelogEl = document.getElementById("git-changelog");
if (changelogEl) {
    fetch("/changelog.json")
        .then((res) => res.json())
        .then((entries) => {
            const shown = entries.slice(0, CHANGELOG_ENTRY_LIMIT);

            const entriesHtml = shown.map((entry) => {
                return `<div class="changelog-entry">
                    <div class="changelog-entry-header">
                        <span class="changelog-version">${escapeHtml(entry.version)}</span>
                        <span class="changelog-date">${escapeHtml(entry.date)}</span>
                    </div>
                    <div class="changelog-subject">${escapeHtml(entry.subject)}</div>
                    ${renderBody(entry.body)}
                    ${renderSignature(entry)}
                </div>`;
            }).join("");

            const moreHtml = `<div class="changelog-more"><a href="${CHANGELOG_MORE_URL}" target="_blank" rel="noopener">See more changes on GitHub</a></div>`;

            changelogEl.innerHTML = entriesHtml + moreHtml;
        })
        .catch((err) => console.error("Failed to load changelog.json", err));
}
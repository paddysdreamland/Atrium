// Top-level so the management About Us editor can preview blocks with the exact same renderer.
function renderAboutBlock(member) {
    const container = document.createElement("div");
    container.className = "section-container";

    const header = document.createElement("h4");
    header.className = "section-header";
    header.textContent = member.name;
    container.appendChild(header);

    const wrap = document.createElement("div");
    wrap.className = "section-float-wrap";

    if (member.image) {
        const img = document.createElement("img");
        img.className = "section-float-image";
        img.src = member.image;
        img.alt = member.name;
        wrap.appendChild(img);
    }

    renderBlocks(wrap, member.body);
    container.appendChild(wrap);

    return container;
}

// The card's blurb: the body's first paragraph as plain text. DOMParser keeps the markup inert.
function aboutSummary(member) {
    const first = member.body.find(block => block.type === "paragraph");
    if (!first) return "";
    return new DOMParser().parseFromString(first.content, "text/html").body.textContent.trim();
}

const aboutRegionNames = "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

// A flag's name, from its path or flag name: "images/flags/de.png" -> "Germany",
// "pride/gay_men" -> "Gay men", "england" -> "England". Top-level for the editor's pickers.
function aboutFlagName(flag) {
    const name = flag.replace(/^images\/flags\/|\.png$/g, "");
    let region = "";
    try {
        region = /^[a-z]{2}$/.test(name) && aboutRegionNames ? aboutRegionNames.of(name.toUpperCase()) : "";
    } catch (err) {
        region = ""; // not a region code the browser knows
    }
    const label = region && region.toLowerCase() !== name ? region : name.replace(/^pride\//, "").replace(/_/g, " ");
    return label.charAt(0).toUpperCase() + label.slice(1);
}

// "2025-03" -> "March 2025".
function aboutMonth(value) {
    const [year, month] = value.split("-").map(Number);
    return new Date(year, month - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
}

// What every About Us card shares, in the toybox buttons' markup: the picture as background
// and icon, then the name, tags and flags. Returns the card and its text column to finish.
function aboutCardBase(tagName, member) {
    const card = document.createElement(tagName);
    card.className = "app-button-wrapper";

    if (member.image) {
        const background = document.createElement("div");
        background.className = "app-background";
        background.style.backgroundImage = `url("${member.image}")`;
        card.appendChild(background);
    }

    const iconWrap = document.createElement("div");
    iconWrap.className = "app-icon-wrapper";
    const icon = document.createElement("div");
    icon.className = member.image ? "app-icon-image" : "app-icon-image about-card-noimage";
    icon.style.backgroundImage = `url("${member.image || "images/silk/user.png"}")`;
    iconWrap.appendChild(icon);
    card.appendChild(iconWrap);

    const text = document.createElement("div");
    text.className = "app-text-wrapper column-4";

    const titleWrap = document.createElement("div");
    titleWrap.className = "app-title-wrapper";
    const title = document.createElement("div");
    title.className = "app-title-text";
    title.textContent = member.name;
    titleWrap.appendChild(title);

    // Their staff role, then Supporter as a second tag if they boost the server too.
    [[member.role, "app-title-tag"], [member.supporter && "Supporter", "app-title-tag about-tag-supporter"]]
        .filter(([label]) => label)
        .forEach(([label, className]) => {
            const tag = document.createElement("div");
            tag.className = className;
            tag.textContent = label;
            titleWrap.appendChild(tag);
        });

    // Pride flags, then the languages they speak (one country flag each); CSS draws the line
    // between the groups, and an empty group isn't drawn at all.
    const flagGroups = [member.pride, member.languages].filter(group => group && group.length);
    if (flagGroups.length) {
        const flags = document.createElement("div");
        flags.className = "app-title-flags";
        flagGroups.forEach(paths => {
            const group = document.createElement("div");
            group.className = "app-title-flag-group";
            paths.forEach(src => {
                const flag = document.createElement("img");
                flag.className = "app-title-flag";
                flag.src = src;
                flag.alt = flag.title = aboutFlagName(src);
                group.appendChild(flag);
            });
            flags.appendChild(group);
        });
        titleWrap.appendChild(flags);
    }

    text.appendChild(titleWrap);
    card.appendChild(text);
    return { card, text };
}

// The description, clamped by .about-card-desc, and the corner note.
function aboutCardText(text, description, corner) {
    const descWrap = document.createElement("div");
    descWrap.className = "app-desc-wrapper";
    const desc = document.createElement("div");
    desc.className = "app-desc-text about-card-desc";
    desc.textContent = description;
    descWrap.appendChild(desc);
    text.appendChild(descWrap);

    if (corner) {
        const note = document.createElement("div");
        note.className = "app-readmore";
        note.textContent = corner;
        text.appendChild(note);
    }
}

// A staff card: opens their block, so it's a button with "Read more". Top-level for the editor preview.
function renderAboutCard(member) {
    const { card, text } = aboutCardBase("button", member);
    aboutCardText(text, aboutSummary(member), "Read more");
    return card;
}

// A supporter card is all there is, so it doesn't click: their tagline, and how long they've
// been boosting where staff cards say "Read more". Top-level for the Supporter Card Editor preview.
function renderSupporterCard(member) {
    const { card, text } = aboutCardBase("div", member);
    card.classList.add("about-card-static");
    aboutCardText(
        text,
        member.tagline || "Supporting Paddy's Dreamland by boosting our Discord server.",
        member.boostingSince ? `Boosting since ${aboutMonth(member.boostingSince)}` : ""
    );
    return card;
}

document.addEventListener("DOMContentLoaded", async () => {
    let about;
    try {
        const response = await fetch("/php/pd_about");
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        about = await response.json();
    } catch (err) {
        console.error("Failed to load About Us:", err);
        return;
    }

    // Two views: everyone as cards under the two headers, or one staff member's block on its own.
    const list = document.getElementById("about-list");
    const detail = document.getElementById("about-detail");
    const supportersHeader = document.getElementById("about-supporters-header");
    if (!list || !detail || !supportersHeader) return;

    function showList() {
        detail.replaceChildren();
        detail.style.display = "none";
        list.style.display = "";
    }

    function showMember(member) {
        const back = document.createElement("a");
        back.className = "section-signature lore-button";
        back.textContent = "Back to everyone";
        back.addEventListener("click", () => {
            playSound("ME_Sound/UI/ME_ProgressionTree_Nav.wav", 0.125);
            showList();
        });

        const block = renderAboutBlock(member);
        block.appendChild(back);
        detail.replaceChildren(block);
        list.style.display = "none";
        detail.style.display = "";
        document.querySelector("#main-holder .main-scrollable")?.scrollTo(0, 0);
    }

    // The endpoint already returns visible blocks, in page order, and supporters in theirs.
    about.staff.forEach(member => {
        const card = renderAboutCard(member);
        // pd_default.js only gives the click sound to buttons that existed at load.
        card.addEventListener("click", () => {
            playSound("ME_Sound/UI/ME_ProgressionTree_Nav.wav", 0.125);
            showMember(member);
        });
        supportersHeader.before(card);
    });
    about.supporters.forEach(member => list.appendChild(renderSupporterCard(member)));

    // The nav button always lands on the list, even when a member is open.
    document.getElementById("about-button")?.addEventListener("click", showList);
});

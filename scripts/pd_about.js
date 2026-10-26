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

    // Blocks with a picture start collapsed to its height. Overflow can only be measured once
    // laid out (sections start hidden), so the observer decides whether there's more to read.
    if (member.image && "ResizeObserver" in window) {
        wrap.classList.add("section-float-collapsed");

        const more = document.createElement("a");
        more.className = "section-signature lore-button";
        more.style.display = "none";
        more.textContent = `Read more about ${member.name}`;
        container.appendChild(more);

        const observer = new ResizeObserver(() => {
            if (wrap.clientHeight === 0) return; // still in a hidden section
            // Compare where the text ends, not scrollHeight: that counts the picture's bottom margin.
            const last = wrap.lastElementChild;
            const clipped = !last.classList.contains("section-float-image")
                && last.getBoundingClientRect().bottom > wrap.getBoundingClientRect().bottom + 1;
            wrap.classList.toggle("section-float-clipped", clipped);
            more.style.display = clipped ? "block" : "none";
        });
        observer.observe(wrap);

        more.addEventListener("click", () => {
            observer.disconnect();
            wrap.classList.remove("section-float-collapsed", "section-float-clipped");
            more.style.display = "none";
        });
    }

    return container;
}

// The card's blurb: the body's first paragraph as plain text. DOMParser keeps the markup inert.
function aboutSummary(member) {
    const first = member.body.find(block => block.type === "paragraph");
    if (!first) return "";
    return new DOMParser().parseFromString(first.content, "text/html").body.textContent.trim();
}

// Same markup as the toybox buttons; the description is clamped by .about-card-desc.
function renderAboutCard(member) {
    const button = document.createElement("button");
    button.className = "app-button-wrapper";

    const iconWrap = document.createElement("div");
    iconWrap.className = "app-icon-wrapper";
    const icon = document.createElement("div");
    icon.className = member.image ? "app-icon-image" : "app-icon-image about-card-noimage";
    icon.style.backgroundImage = `url("${member.image || "images/silk/user.png"}")`;
    iconWrap.appendChild(icon);
    button.appendChild(iconWrap);

    const text = document.createElement("div");
    text.className = "app-text-wrapper column-4";

    const titleWrap = document.createElement("div");
    titleWrap.className = "app-title-wrapper";
    const title = document.createElement("div");
    title.className = "app-title-text";
    title.textContent = member.name;
    titleWrap.appendChild(title);
    text.appendChild(titleWrap);

    const descWrap = document.createElement("div");
    descWrap.className = "app-desc-wrapper";
    const desc = document.createElement("div");
    desc.className = "app-desc-text about-card-desc";
    desc.textContent = aboutSummary(member);
    descWrap.appendChild(desc);
    text.appendChild(descWrap);

    button.appendChild(text);
    return button;
}

document.addEventListener("DOMContentLoaded", async () => {
    let members;
    try {
        const response = await fetch("/php/pd_about");
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        members = await response.json();
    } catch (err) {
        console.error("Failed to load About Us:", err);
        return;
    }

    const wrapper = document.querySelector("#about-section .section-wrapper");
    if (!wrapper) return;

    // Two views: everyone as cards, or one member's block on its own.
    const list = document.createElement("div");
    list.className = "app-buttons-wrapper";
    const detail = document.createElement("div");
    detail.style.display = "none";
    wrapper.append(list, detail);

    function showList() {
        detail.replaceChildren();
        detail.style.display = "none";
        list.style.display = "";
    }

    // Rendered fresh each time so the block starts collapsed again, and measures while visible.
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

    // The endpoint already returns visible blocks, in page order.
    members.forEach(member => {
        const card = renderAboutCard(member);
        // pd_default.js only gives the click sound to buttons that existed at load.
        card.addEventListener("click", () => {
            playSound("ME_Sound/UI/ME_ProgressionTree_Nav.wav", 0.125);
            showMember(member);
        });
        list.appendChild(card);
    });

    // The nav button always lands on the list, even when a member is open.
    document.getElementById("about-button")?.addEventListener("click", showList);
});

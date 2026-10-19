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

    // The endpoint already returns visible blocks, in page order.
    const wrapper = document.querySelector("#about-section .section-wrapper");

    if (wrapper) {
        members.forEach(member => wrapper.appendChild(renderAboutBlock(member)));
    }
});

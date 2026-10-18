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

/* Management - About Us */

// Moderators and up (about.edit) write their own About Us block; the Founder
// (about.manage) can also edit, reorder and delete anyone's. Cosmetic like the rest of
// management: php/pd_about_admin.php enforces all of it. Builds on pd_manage.js.

const AM_API = "/php/pd_about_admin";

const am = {
    canManage: false,
    ownId: "",
    displayName: "",
    blocks: [],
    flagOptions: {}, // name => path of every flag the server accepts
    draft: null,  // the block being edited, in the editor/API shape
    isNew: false,
    previewTimer: 0
};

// How the About Us editor's block list reports edits (see pmRenderBlocks).
const AM_EDITOR = {
    statusId: "am-status",
    onChange: soon => soon ? amRenderPreviewSoon() : amRenderPreview()
};

function amHasOwnBlock() {
    return am.blocks.some(block => block.discordId === am.ownId);
}

/* Auth */

function amOnAuth(data) {
    const permissions = (data && data.authenticated && data.permissions) || [];
    am.canManage = permissions.includes("about.manage");
    am.displayName = (data && data.user && data.user.displayName) || "";

    if (permissions.includes("about.edit")) amLoad();
}

/* Block List */

async function amLoad() {
    try {
        const data = await pmApi(AM_API);
        am.ownId = data.ownId;
        am.blocks = data.blocks;
        am.flagOptions = data.flagOptions || {};
        amRenderList();
    } catch (err) {
        pmError(err, "am-status");
    }
}

function amRenderList() {
    const list = document.getElementById("am-list");
    list.replaceChildren();

    // Everyone can make their own block; only the Founder can make one for someone else.
    const newButton = document.getElementById("am-new");
    newButton.textContent = amHasOwnBlock() ? "New Block" : "Create My Block";
    newButton.style.display = (am.canManage || !amHasOwnBlock()) ? "" : "none";

    if (am.blocks.length === 0) {
        list.append(pmEl("div", "setting-label-small", am.canManage ? "No blocks yet." : "You don't have a block yet."));
        return;
    }

    am.blocks.forEach(block => {
        const row = pmEl("div", "pm-row");
        if (am.canManage) row.append(pmEl("div", "pm-row-date", `#${block.sortOrder}`));
        row.append(pmEl("div", "pm-row-title", block.name));
        if (block.ownerName && block.ownerName !== block.name) {
            row.append(pmEl("div", "pm-row-date", `@${block.ownerName}`));
        }

        if (block.discordId === am.ownId) row.append(pmEl("div", "pm-badge", "You"));
        if (block.hidden) row.append(pmEl("div", "pm-badge pm-badge-hidden", "Hidden"));

        const edit = pmEl("button", "setting-button", "Edit");
        edit.addEventListener("click", () => amOpenEditor(block));
        row.append(edit);

        list.append(row);
    });
}

/* Editor */

function amOpenEditor(block) {
    am.isNew = !block;
    am.draft = block
        ? JSON.parse(JSON.stringify(block))
        : {
            // Your own block first; after that, a new one is the Founder adding someone else's.
            discordId: amHasOwnBlock() ? "" : am.ownId,
            name: amHasOwnBlock() ? "" : am.displayName,
            image: "",
            role: null, // from the owner's Discord roles; the server fills it in on save
            flags: [],
            sortOrder: am.blocks.reduce((max, b) => Math.max(max, b.sortOrder), 0) + 1,
            hidden: true, // new blocks start as drafts
            body: [{ type: "paragraph", content: "" }]
        };

    document.getElementById("am-editor-title").textContent = am.isNew ? "New Block" : "Edit Block";
    document.getElementById("am-name").value = am.draft.name;
    document.getElementById("am-image").value = am.draft.image || "";
    document.getElementById("am-discord-id").value = am.draft.discordId;
    document.getElementById("am-discord-id").disabled = !am.isNew; // the account a block belongs to is fixed once created
    document.getElementById("am-order").value = am.draft.sortOrder;
    document.getElementById("am-manager-fields").style.display = am.canManage ? "" : "none";
    document.getElementById("am-hidden").checked = am.draft.hidden;
    document.getElementById("am-delete").style.display = am.isNew ? "none" : "";

    amRenderFlags();
    pmRenderBlocks(document.getElementById("am-blocks"), am.draft.body, AM_EDITOR);
    amRenderPreview();
    pmStatus("", "", "am-status");

    const editor = document.getElementById("am-editor");
    editor.style.display = "";
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function amCloseEditor() {
    am.draft = null;
    document.getElementById("am-editor").style.display = "none";
}

/* Flags */

const AM_MAX_FLAGS = 8; // same limit as pd_about_admin.php
const amRegionNames = "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

// "de" -> "Germany (de)", "pride/trans" -> "Pride: trans"; the name itself when unsure.
function amFlagLabel(name) {
    if (name.startsWith("pride/")) return `Pride: ${name.slice(6).replace(/_/g, " ")}`;
    let region = "";
    try {
        region = /^[a-z]{2}$/.test(name) && amRegionNames ? amRegionNames.of(name.toUpperCase()) : "";
    } catch (err) {
        region = ""; // not a region code the browser knows
    }
    return region && region.toLowerCase() !== name ? `${region} (${name})` : name.replace(/_/g, " ");
}

function amFlagName(path) {
    return Object.keys(am.flagOptions).find(name => am.flagOptions[name] === path) || path;
}

// The chosen flags as removable chips, and a picker with the rest.
function amRenderFlags() {
    const list = document.getElementById("am-flags");
    list.replaceChildren();
    am.draft.flags.forEach((path, i) => {
        const chip = pmEl("button", "pm-badge am-flag-chip");
        chip.title = "Remove";
        const img = pmEl("img");
        img.src = path;
        img.alt = "";
        chip.append(img, amFlagLabel(amFlagName(path)));
        chip.addEventListener("click", () => {
            am.draft.flags.splice(i, 1);
            amRenderFlags();
            amRenderPreview();
        });
        list.append(chip);
    });

    const picker = document.getElementById("am-flag-pick");
    const full = am.draft.flags.length >= AM_MAX_FLAGS;
    const placeholder = pmEl("option", "", full ? `That's ${AM_MAX_FLAGS} flags, the most a card can show.` : "Add a flag…");
    placeholder.value = "";
    picker.replaceChildren(placeholder);
    picker.disabled = full;

    Object.keys(am.flagOptions)
        .filter(name => !am.draft.flags.includes(am.flagOptions[name]))
        .map(name => ({ name, label: amFlagLabel(name) }))
        .sort((a, b) => a.label.localeCompare(b.label))
        .forEach(({ name, label }) => {
            const option = pmEl("option", "", label);
            option.value = name;
            picker.append(option);
        });
}

function amAddBlock(type) {
    am.draft.body.push(pmNewBlock(type));
    pmRenderBlocks(document.getElementById("am-blocks"), am.draft.body, AM_EDITOR);
    amRenderPreview();
}

function amRenderPreview() {
    clearTimeout(am.previewTimer);
    const holder = document.getElementById("am-preview");
    holder.replaceChildren();
    if (!am.draft) return;

    // Same renderers as the public About Us page (pd_about.js): the card, then the block it opens.
    // See pmRenderPreview. Flags are always ones the server listed, so they exist.
    const member = {
        name: am.draft.name,
        image: pmValidPath(am.draft.image, "png|jpe?g|gif|webp") ? am.draft.image : "",
        role: am.draft.role,
        flags: am.draft.flags,
        body: pmPreviewBody(am.draft.body)
    };
    const card = pmEl("div", "app-buttons-wrapper");
    card.append(renderAboutCard(member));
    holder.append(card, renderAboutBlock(member));
    pmWatchMissing(holder, "am-status", amRenderPreviewSoon);
}

// For typing in media paths: wait until the typing stops before redrawing.
function amRenderPreviewSoon() {
    clearTimeout(am.previewTimer);
    am.previewTimer = setTimeout(amRenderPreview, 600);
}

async function amUploadImage(file) {
    const button = document.getElementById("am-image-upload");
    button.disabled = true;

    try {
        pmStatus("Uploading…", "", "am-status");
        am.draft.image = await pmUploadImage(file);
        document.getElementById("am-image").value = am.draft.image;
        amRenderPreview();
        pmStatus("Uploaded. Remember to save.", "", "am-status");
    } catch (err) {
        pmError(err, "am-status");
    } finally {
        button.disabled = false;
    }
}

async function amSave() {
    const save = document.getElementById("am-save");
    save.disabled = true;

    try {
        const data = await pmApi(AM_API, { action: am.isNew ? "create" : "update", block: am.draft });
        await amLoad();
        amOpenEditor(data.block);
        pmStatus("Saved. Reload the page to see it on the About Us page.", "", "am-status");
    } catch (err) {
        pmError(err, "am-status");
    } finally {
        save.disabled = false;
    }
}

async function amDelete() {
    if (!confirm(`Permanently delete the "${am.draft.name}" block? This cannot be undone. (Tick "Hidden" instead to just take it down.)`)) {
        return;
    }

    try {
        await pmApi(AM_API, { action: "delete", discordId: am.draft.discordId });
        amCloseEditor();
        await amLoad();
        pmStatus("Block deleted.", "", "am-status");
    } catch (err) {
        pmError(err, "am-status");
    }
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("am-new").addEventListener("click", () => amOpenEditor(null));
    document.getElementById("am-cancel").addEventListener("click", amCloseEditor);
    document.getElementById("am-save").addEventListener("click", amSave);
    document.getElementById("am-delete").addEventListener("click", amDelete);

    Object.keys(PM_BLOCK_LABELS).forEach(type => {
        document.getElementById(`am-add-${type}`).addEventListener("click", () => amAddBlock(type));
    });

    document.getElementById("am-name").addEventListener("input", (e) => {
        am.draft.name = e.target.value;
        amRenderPreview();
    });
    document.getElementById("am-image").addEventListener("input", (e) => {
        am.draft.image = e.target.value.trim();
        amRenderPreviewSoon();
    });
    document.getElementById("am-discord-id").addEventListener("input", (e) => {
        am.draft.discordId = e.target.value.trim();
    });
    document.getElementById("am-order").addEventListener("input", (e) => {
        am.draft.sortOrder = Number(e.target.value);
    });
    document.getElementById("am-hidden").addEventListener("change", (e) => {
        am.draft.hidden = e.target.checked;
    });
    document.getElementById("am-flag-pick").addEventListener("change", (e) => {
        const path = am.flagOptions[e.target.value];
        if (!path) return;
        am.draft.flags.push(path);
        amRenderFlags();
        amRenderPreview();
    });

    const picker = document.getElementById("am-image-file");
    document.getElementById("am-image-upload").addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
        const file = picker.files[0];
        picker.value = "";
        if (file) amUploadImage(file);
    });

    // pd_discordauth.js announces the login state; catch it even if it already fired.
    if (window.pdAuth) amOnAuth(window.pdAuth);
    document.addEventListener("pd:auth", (e) => amOnAuth(e.detail));
});

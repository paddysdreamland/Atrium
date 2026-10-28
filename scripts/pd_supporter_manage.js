/* Management - Supporter Cards */

// Supporters (supporter.edit) choose their card's tagline and flags, or hide it; its name and
// picture come from their Discord profile. The Founder (supporter.manage) can edit anyone's, say
// how they support, take a card down, and add cards by hand for people who don't boost. Cosmetic
// like the rest of management: php/pd_supporters_admin.php enforces all of it. Builds on
// pd_manage.js and the flag pickers in pd_about_manage.js.

const SM_API = "/php/pd_supporters_admin";

const sm = {
    canManage: false,
    ownId: "",
    cards: [],
    flagOptions: {}, // name => path of every flag the server accepts
    draft: null,     // the card being edited, in the editor/API shape
    isNew: false,
    previewTimer: 0
};

/* Auth */

function smOnAuth(data) {
    const permissions = (data && data.authenticated && data.permissions) || [];
    sm.canManage = permissions.includes("supporter.manage");
    document.getElementById("sm-new").style.display = sm.canManage ? "" : "none";

    if (sm.canManage || permissions.includes("supporter.edit")) smLoad();
}

/* Card List */

async function smLoad() {
    try {
        const data = await pmApi(SM_API);
        sm.ownId = data.ownId;
        sm.cards = data.cards;
        sm.flagOptions = data.flagOptions || {};
        smRenderList();
    } catch (err) {
        pmError(err, "sm-status");
    }
}

function smRenderList() {
    const list = document.getElementById("sm-list");
    list.replaceChildren();

    if (sm.cards.length === 0) {
        list.append(pmEl("div", "setting-label-small", sm.canManage
            ? "No supporters yet. Boosters show up here once they've connected Discord on the site."
            : "You don't have a card yet. Log in again so the site can see your Supporter role."));
        return;
    }

    sm.cards.forEach(card => {
        const row = pmEl("div", "pm-row");
        row.append(pmEl("div", "pm-row-title", card.name));

        if (card.discordId && card.discordId === sm.ownId) row.append(pmEl("div", "pm-badge", "You"));
        if (card.manual) row.append(pmEl("div", "pm-badge", "Added by Hand"));
        if (card.inStaff) row.append(pmEl("div", "pm-badge", "In Staff"));
        if (card.hidden) row.append(pmEl("div", "pm-badge pm-badge-hidden", "Hidden"));
        if (card.removed) row.append(pmEl("div", "pm-badge pm-badge-hidden", "Taken Down"));

        const edit = pmEl("button", "setting-button", "Edit");
        edit.addEventListener("click", () => smOpenEditor(card));
        row.append(edit);

        list.append(row);
    });
}

/* Editor */

function smOpenEditor(card) {
    sm.isNew = !card;
    sm.draft = card
        ? JSON.parse(JSON.stringify(card))
        : {
            // Only the Founder adds cards: one by hand, until they log in with Discord (if ever).
            id: null,
            discordId: "",
            manual: true,
            fallbackName: "",
            fallbackImage: "",
            support: "",
            tagline: "",
            pride: [],
            languages: [],
            hidden: true, // new cards start as drafts
            removed: false,
            hasLogin: false,
            inStaff: false,
            name: "",
            image: null,
            role: null,
            supporter: true,
            boostingSince: null
        };
    const own = !sm.isNew && card.discordId === sm.ownId;

    document.getElementById("sm-editor-title").textContent = sm.isNew ? "New Card" : own ? "Your Card" : `${card.name}'s Card`;
    document.getElementById("sm-tagline").value = sm.draft.tagline;
    document.getElementById("sm-hidden").checked = sm.draft.hidden;

    // The Founder's fields: how they support, and on cards added by hand, who they are.
    const byHand = sm.canManage && sm.draft.manual;
    document.getElementById("sm-support-field").style.display = sm.canManage ? "" : "none";
    document.getElementById("sm-support").value = sm.draft.support;
    document.getElementById("sm-manual-fields").style.display = byHand ? "" : "none";
    document.getElementById("sm-name").value = sm.draft.fallbackName;
    document.getElementById("sm-discord-id").value = sm.draft.manual ? sm.draft.discordId : "";
    document.getElementById("sm-image").value = sm.draft.fallbackImage;
    document.getElementById("sm-delete").style.display = byHand && !sm.isNew ? "" : "none";

    // Only the Founder changes "taken down"; its owner only sees it once it's ticked.
    const removed = document.getElementById("sm-removed");
    removed.checked = sm.draft.removed;
    removed.disabled = !sm.canManage;
    document.getElementById("sm-removed-label").style.display = (sm.canManage || sm.draft.removed) ? "" : "none";

    ["pride", "languages"].forEach(kind => amRenderFlags("sm", sm.draft, kind, sm.flagOptions, smRenderPreview));
    smRenderPreview();
    smExplain();

    const editor = document.getElementById("sm-editor");
    editor.style.display = "";
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

// Why the About Us page might show something other than this editor's fields.
function smExplain() {
    const draft = sm.draft;
    const own = draft.discordId && draft.discordId === sm.ownId;
    const notes = [];
    if (draft.inStaff) {
        notes.push(`${own ? "You have" : "They have"} a staff block, so the About Us page shows ${own ? "you" : "them"} under Our Staff with a Supporter tag instead of this card.`);
    }
    if (draft.manual && draft.hasLogin && sm.canManage) {
        notes.push("They've logged in with Discord, so the card shows their Discord name and picture instead of the ones below.");
    }
    pmStatus(notes.join(" "), "", "sm-status");
}

function smCloseEditor() {
    sm.draft = null;
    document.getElementById("sm-editor").style.display = "none";
}

function smRenderPreview() {
    clearTimeout(sm.previewTimer);
    const holder = document.getElementById("sm-preview");
    holder.replaceChildren();
    if (!sm.draft) return;

    // Same renderer as the public About Us page (pd_about.js); text is drawn with textContent, so
    // unsaved text is safe to show as typed. Until they log in, a card added by hand shows the
    // name and picture typed here, and only a picture path the server would accept (see pmPreviewBody).
    const draft = sm.draft;
    const fallbackImage = pmValidPath(draft.fallbackImage, "png|jpe?g|gif|webp") ? draft.fallbackImage : "";
    const card = pmEl("div", "app-buttons-wrapper");
    card.append(renderSupporterCard({
        ...draft,
        name: draft.hasLogin ? draft.name : draft.fallbackName.trim(),
        image: draft.hasLogin ? draft.image : fallbackImage,
        support: draft.support.trim(),
        tagline: draft.tagline.trim()
    }));
    holder.append(card);
    pmWatchMissing(holder, "sm-status", smRenderPreviewSoon);
}

// For typing in a picture path: wait until the typing stops before redrawing.
function smRenderPreviewSoon() {
    clearTimeout(sm.previewTimer);
    sm.previewTimer = setTimeout(smRenderPreview, 600);
}

async function smUploadImage(file) {
    const button = document.getElementById("sm-image-upload");
    button.disabled = true;

    try {
        pmStatus("Uploading…", "", "sm-status");
        sm.draft.fallbackImage = await pmUploadImage(file);
        document.getElementById("sm-image").value = sm.draft.fallbackImage;
        smRenderPreview();
        pmStatus("Uploaded. Remember to save.", "", "sm-status");
    } catch (err) {
        pmError(err, "sm-status");
    } finally {
        button.disabled = false;
    }
}

async function smSave() {
    const save = document.getElementById("sm-save");
    save.disabled = true;

    try {
        const data = await pmApi(SM_API, { action: sm.isNew ? "create" : "update", card: sm.draft });
        await smLoad();
        smOpenEditor(data.card);
        pmStatus("Saved. Reload the page to see it on the About Us page.", "", "sm-status");
    } catch (err) {
        pmError(err, "sm-status");
    } finally {
        save.disabled = false;
    }
}

async function smDelete() {
    if (!confirm(`Permanently delete the card for "${sm.draft.fallbackName}"? This cannot be undone. (Tick "Hide this card" instead to just take it down.)`)) {
        return;
    }

    try {
        await pmApi(SM_API, { action: "delete", id: sm.draft.id });
        smCloseEditor();
        await smLoad();
        pmStatus("Card deleted.", "", "sm-status");
    } catch (err) {
        pmError(err, "sm-status");
    }
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("sm-new").addEventListener("click", () => smOpenEditor(null));
    document.getElementById("sm-cancel").addEventListener("click", smCloseEditor);
    document.getElementById("sm-save").addEventListener("click", smSave);
    document.getElementById("sm-delete").addEventListener("click", smDelete);

    // Text fields: [id, draft key, redraw the preview soon (a path being typed)?]
    [["sm-tagline", "tagline"], ["sm-support", "support"], ["sm-name", "fallbackName"],
     ["sm-discord-id", "discordId"], ["sm-image", "fallbackImage", true]].forEach(([id, key, soon]) => {
        document.getElementById(id).addEventListener("input", (e) => {
            sm.draft[key] = key === "discordId" || key === "fallbackImage" ? e.target.value.trim() : e.target.value;
            soon ? smRenderPreviewSoon() : smRenderPreview();
        });
    });
    document.getElementById("sm-hidden").addEventListener("change", (e) => {
        sm.draft.hidden = e.target.checked;
    });
    document.getElementById("sm-removed").addEventListener("change", (e) => {
        sm.draft.removed = e.target.checked;
    });

    const picker = document.getElementById("sm-image-file");
    document.getElementById("sm-image-upload").addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
        const file = picker.files[0];
        picker.value = "";
        if (file) smUploadImage(file);
    });

    // pd_discordauth.js announces the login state; catch it even if it already fired.
    if (window.pdAuth) smOnAuth(window.pdAuth);
    document.addEventListener("pd:auth", (e) => smOnAuth(e.detail));
});

/* Management - Supporter Cards */

// Supporters (supporter.edit) choose their card's tagline and flags, or hide it; its name and
// picture come from their Discord profile. The Founder (supporter.manage) can edit anyone's and
// take a card down. Cosmetic like the rest of management: php/pd_supporters_admin.php enforces
// all of it. Builds on pd_manage.js and the flag pickers in pd_about_manage.js.

const SM_API = "/php/pd_supporters_admin";

const sm = {
    canManage: false,
    ownId: "",
    cards: [],
    flagOptions: {}, // name => path of every flag the server accepts
    draft: null      // the card being edited, in the editor/API shape
};

/* Auth */

function smOnAuth(data) {
    const permissions = (data && data.authenticated && data.permissions) || [];
    sm.canManage = permissions.includes("supporter.manage");

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

        if (card.discordId === sm.ownId) row.append(pmEl("div", "pm-badge", "You"));
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
    sm.draft = JSON.parse(JSON.stringify(card));
    const own = card.discordId === sm.ownId;

    document.getElementById("sm-editor-title").textContent = own ? "Your Card" : `${card.name}'s Card`;
    document.getElementById("sm-tagline").value = sm.draft.tagline;
    document.getElementById("sm-hidden").checked = sm.draft.hidden;

    // Only the Founder changes "taken down"; its owner only sees it once it's ticked.
    const removed = document.getElementById("sm-removed");
    removed.checked = sm.draft.removed;
    removed.disabled = !sm.canManage;
    document.getElementById("sm-removed-label").style.display = (sm.canManage || sm.draft.removed) ? "" : "none";

    ["pride", "languages"].forEach(kind => amRenderFlags("sm", sm.draft, kind, sm.flagOptions, smRenderPreview));
    smRenderPreview();

    // A staff block wins: the About Us page shows them as staff, with a Supporter tag.
    pmStatus(card.inStaff
        ? `${own ? "You have" : "They have"} a staff block, so the About Us page shows ${own ? "you" : "them"} under Our Staff with a Supporter tag instead of this card.`
        : "", "", "sm-status");

    const editor = document.getElementById("sm-editor");
    editor.style.display = "";
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function smCloseEditor() {
    sm.draft = null;
    document.getElementById("sm-editor").style.display = "none";
}

function smRenderPreview() {
    const holder = document.getElementById("sm-preview");
    holder.replaceChildren();
    if (!sm.draft) return;

    // Same renderer as the public About Us page (pd_about.js). The tagline is drawn with
    // textContent, so unsaved text is safe to show as typed.
    const card = pmEl("div", "app-buttons-wrapper");
    card.append(renderSupporterCard({ ...sm.draft, tagline: sm.draft.tagline.trim() }));
    holder.append(card);
}

async function smSave() {
    const save = document.getElementById("sm-save");
    save.disabled = true;

    try {
        const data = await pmApi(SM_API, { action: "update", card: sm.draft });
        await smLoad();
        smOpenEditor(data.card);
        pmStatus("Saved. Reload the page to see it on the About Us page.", "", "sm-status");
    } catch (err) {
        pmError(err, "sm-status");
    } finally {
        save.disabled = false;
    }
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("sm-cancel").addEventListener("click", smCloseEditor);
    document.getElementById("sm-save").addEventListener("click", smSave);

    document.getElementById("sm-tagline").addEventListener("input", (e) => {
        sm.draft.tagline = e.target.value;
        smRenderPreview();
    });
    document.getElementById("sm-hidden").addEventListener("change", (e) => {
        sm.draft.hidden = e.target.checked;
    });
    document.getElementById("sm-removed").addEventListener("change", (e) => {
        sm.draft.removed = e.target.checked;
    });

    // pd_discordauth.js announces the login state; catch it even if it already fired.
    if (window.pdAuth) smOnAuth(window.pdAuth);
    document.addEventListener("pd:auth", (e) => smOnAuth(e.detail));
});

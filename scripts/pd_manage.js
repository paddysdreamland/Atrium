/* Management */

// Everything in here is cosmetic: it only decides what to show. The server
// re-checks the user's Discord roles on every request (see php/pd_posts_admin.php).
// The block editor, uploads and status helpers are shared with pd_about_manage.js.

// Extensionless on purpose: .htaccess 301s "*.php", and a redirected POST arrives as a GET.
const PM_API = "/php/pd_posts_admin";
const PM_UPLOAD_API = "/php/pd_upload_image";
const PM_UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // keep in sync with PD_UPLOAD_MAX_BYTES in pd_upload_image.php

const PM_BLOCK_LABELS = {
    paragraph: "Paragraph",
    heading: "Heading",
    bulletList: "Bullet List (one item per line)",
    audio: "Audio (.mp3 path on this site)",
    gallery: "Gallery (one image per line: path | optional caption)"
};

const pm = {
    permissions: [],
    displayName: "",
    posts: [],
    draft: null,      // the post being edited, in the editor/API shape
    isNew: false,
    keyTouched: false, // stop auto-generating the key once it's been typed in
    previewTimer: 0,
    missingPaths: new Set() // media paths that 404'd once; never requested again (see pmPreviewBody)
};

// How the post editor's block list reports edits (see pmRenderBlocks).
const PM_EDITOR = {
    statusId: "pm-status",
    onChange: soon => soon ? pmRenderPreviewSoon() : pmRenderPreview()
};

function pmCan(permission) {
    return pm.permissions.includes(permission);
}

function pmEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

/* Auth */

function pmOnAuth(data) {
    pm.permissions = (data && data.authenticated && data.permissions) || [];
    pm.displayName = (data && data.user && data.user.displayName) || "";

    const canNews = pmCan("news.manage");
    const canAbout = pmCan("about.edit");
    const access = {
        "manage-section": canNews || canAbout,
        "newsmanager-section": canNews,
        "aboutmanager-section": canAbout
    };

    document.getElementById("manage-holder").style.display = access["manage-section"] ? "" : "none";
    document.getElementById("newsmanager-button").style.display = canNews ? "" : "none";
    document.getElementById("aboutmanager-button").style.display = canAbout ? "" : "none";

    // Don't leave someone parked on a tool they can't use (e.g. restored from lastVisitedSection).
    const onLockedPage = Object.keys(access)
        .some(id => !access[id] && document.getElementById(id).style.display === "block");
    if (onLockedPage) openSection("home");

    if (canNews) pmLoadPosts();
}

/* API */

async function pmApi(url, body) {
    const options = body === undefined
        ? { headers: { "Accept": "application/json" } }
        : {
            method: "POST",
            headers: { "Accept": "application/json", "Content-Type": "application/json" },
            body: JSON.stringify(body)
        };

    return pmParse(await fetch(url, options));
}

// Upload one image; resolves to its site path, e.g. "images/uploads/<id>/<random>.png".
async function pmUploadImage(file) {
    if (file.size > PM_UPLOAD_MAX_BYTES) {
        throw new Error(`"${file.name}" is over 8 MB.`);
    }

    const form = new FormData();
    form.append("image", file);
    const data = await pmParse(await fetch(PM_UPLOAD_API, {
        method: "POST",
        headers: { "Accept": "application/json" },
        body: form
    }));
    return data.src;
}

async function pmParse(res) {
    let data = null;
    try {
        data = await res.json();
    } catch (e) {
        // non-JSON (e.g. a PHP fatal) — handled below
    }

    if (!res.ok || !data || data.ok === false) {
        const err = new Error((data && data.message) || `Request failed (${res.status}).`);
        err.code = data && data.error;
        throw err;
    }
    return data;
}

/* Status */

function pmStatus(message, kind, statusId = "pm-status") {
    const status = document.getElementById(statusId);
    status.replaceChildren();

    if (!message) {
        status.style.display = "none";
        return;
    }

    status.className = kind === "error" ? "pm-status pm-status-error" : "pm-status";
    status.append(pmEl("span", "", message));
    status.style.display = "";
}

function pmError(err, statusId = "pm-status") {
    pmStatus(err.message, "error", statusId);

    if (err.code === "reauth_required") {
        // Logging in again re-reads their roles; prompt=none makes it a quick bounce.
        const button = pmEl("button", "setting-button pm-status-action", "Re-verify");
        button.addEventListener("click", () => { window.location.href = "/auth/login.php"; });
        document.getElementById(statusId).append(button);
    }
}

/* Block Editor */

// Draw an editable block list into holder. editor.onChange(soon) runs after every edit
// (soon: a media path is being typed, so wait for the typing to stop before redrawing);
// editor.statusId is where upload progress and errors go.
function pmRenderBlocks(holder, blocks, editor) {
    holder.replaceChildren();

    const redraw = () => {
        pmRenderBlocks(holder, blocks, editor);
        editor.onChange();
    };

    blocks.forEach((block, index) => {
        const wrapper = pmEl("div", "pm-block");

        const head = pmEl("div", "spaced-out");
        head.append(pmEl("div", "setting-label-small", PM_BLOCK_LABELS[block.type] || block.type));

        const actions = pmEl("div", "row-4");
        [["▲", -1, "Move up"], ["▼", 1, "Move down"]].forEach(([label, offset, title]) => {
            const button = pmEl("button", "setting-button pm-block-button", label);
            button.title = title;
            button.disabled = !blocks[index + offset];
            button.addEventListener("click", () => {
                [blocks[index], blocks[index + offset]] = [blocks[index + offset], blocks[index]];
                redraw();
            });
            actions.append(button);
        });

        const remove = pmEl("button", "setting-button-danger pm-block-button", "✕");
        remove.title = "Remove block";
        remove.addEventListener("click", () => {
            blocks.splice(index, 1);
            redraw();
        });
        actions.append(remove);
        head.append(actions);
        wrapper.append(head);

        let input;
        let extra = null;
        if (block.type === "audio") {
            input = pmEl("input", "input-field pm-input");
            input.type = "text";
            input.placeholder = "sounds/news/example.mp3";
            input.value = block.src || "";
            input.addEventListener("input", () => {
                block.src = input.value.trim();
                editor.onChange(true);
            });
        } else if (block.type === "gallery") {
            input = pmEl("textarea", "input-field pm-input pm-textarea");
            input.placeholder = "images/news/example1.png | A caption\nimages/news/example2.png";
            input.value = (block.images || [])
                .map(image => image.caption ? `${image.src} | ${image.caption}` : image.src)
                .join("\n");
            input.addEventListener("input", () => {
                block.images = input.value.split("\n")
                    .filter(line => line.trim() !== "")
                    .map(line => {
                        const bar = line.indexOf("|");
                        return bar === -1
                            ? { src: line.trim() }
                            : { src: line.slice(0, bar).trim(), caption: line.slice(bar + 1).trim() };
                    });
                editor.onChange(true);
            });

            extra = pmGalleryUploader(block, redraw, editor.statusId);
        } else if (block.type === "heading") {
            input = pmEl("input", "input-field pm-input");
            input.type = "text";
            input.maxLength = 255;
            input.placeholder = "What I Do:";
            input.value = block.content || "";
            input.addEventListener("input", () => {
                block.content = input.value;
                editor.onChange();
            });
        } else if (block.type === "bulletList") {
            input = pmEl("textarea", "input-field pm-input pm-textarea");
            input.value = (block.content || []).join("\n");
            input.addEventListener("input", () => {
                block.content = input.value.split("\n").filter(item => item.trim() !== "");
                editor.onChange();
            });
        } else {
            input = pmEl("textarea", "input-field pm-input pm-textarea");
            input.value = block.content || "";
            input.addEventListener("input", () => {
                block.content = input.value;
                editor.onChange();
            });
        }
        wrapper.append(input);
        if (extra) wrapper.append(extra);

        holder.append(wrapper);
    });
}

// "Upload Images" button for a gallery block: uploads each picked file, then appends it.
function pmGalleryUploader(block, redraw, statusId) {
    const holder = pmEl("div", "setting-input-holder pm-add-row");

    const picker = pmEl("input");
    picker.type = "file";
    picker.accept = "image/png,image/jpeg,image/gif,image/webp";
    picker.multiple = true;
    picker.style.display = "none";

    const button = pmEl("button", "setting-button", "Upload Images");
    button.addEventListener("click", () => picker.click());

    picker.addEventListener("change", async () => {
        const files = [...picker.files];
        picker.value = "";
        if (files.length === 0) return;

        button.disabled = true;
        let uploaded = 0;
        try {
            for (const file of files) {
                pmStatus(`Uploading ${uploaded + 1} of ${files.length}…`, "", statusId);
                const src = await pmUploadImage(file);
                block.images = [...(block.images || []), { src }];
                uploaded++;
            }
            pmStatus(`Uploaded ${uploaded} image${uploaded === 1 ? "" : "s"}. Remember to save.`, "", statusId);
        } catch (err) {
            pmError(err, statusId);
        } finally {
            button.disabled = false;
            // Rebuild the blocks so the textarea lists whatever made it up.
            redraw();
        }
    });

    holder.append(button, picker);
    return holder;
}

function pmNewBlock(type) {
    return type === "audio" ? { type, src: "" }
        : type === "gallery" ? { type, images: [] }
        : type === "bulletList" ? { type, content: [] }
        : { type, content: "" };
}

/* Previews */

// Same rule as pd_blocks_valid_path() in pd_blocks.php, minus paths already known to 404.
function pmValidPath(src, extensions) {
    return new RegExp(`^/?[A-Za-z0-9_\\-./%]+\\.(?:${extensions})$`, "i").test(src || "")
        && !src.includes("..") && !src.includes("//")
        && !pm.missingPaths.has(src);
}

// A block list as previews draw it: media only for paths the server would accept.
// Every half-typed path would be a 404, and the site guard (php/pd_log.php) bans an
// IP for 7 days after 4 of those in 4 seconds, so they must never be requested.
function pmPreviewBody(blocks) {
    return blocks
        .map(block => block.type === "gallery"
            ? { ...block, images: (block.images || []).filter(image => pmValidPath(image.src, "png|jpe?g|gif|webp")) }
            : block)
        .filter(block => !(block.type === "audio" && !pmValidPath(block.src, "mp3")))
        .filter(block => !(block.type === "gallery" && block.images.length === 0));
}

// Remember anything in a freshly drawn preview that 404s, so later redraws don't request it again.
function pmWatchMissing(holder, statusId, redrawSoon) {
    holder.querySelectorAll("img, source").forEach(el => {
        el.addEventListener("error", () => {
            const src = el.getAttribute("src");
            if (pm.missingPaths.has(src)) return;
            pm.missingPaths.add(src);
            pmStatus(`Couldn't find "${src}" on the site. Check the path, or upload it.`, "error", statusId);
            redrawSoon();
        }, { once: true });
    });
}

/* Post List */

async function pmLoadPosts() {
    try {
        const data = await pmApi(PM_API);
        pm.posts = data.posts;
        pmRenderList();
    } catch (err) {
        pmError(err);
    }
}

function pmRenderList() {
    const list = document.getElementById("pm-list");
    list.replaceChildren();

    if (pm.posts.length === 0) {
        list.append(pmEl("div", "setting-label-small", "No posts yet."));
        return;
    }

    pm.posts.forEach(post => {
        const row = pmEl("div", "pm-row");
        row.append(pmEl("div", "pm-row-date", post.postDate));
        row.append(pmEl("div", "pm-row-title", post.postHeader));

        if (post.hidden) row.append(pmEl("div", "pm-badge pm-badge-hidden", "Hidden"));
        if (post.irrelevant) row.append(pmEl("div", "pm-badge", "Outdated"));

        const edit = pmEl("button", "setting-button", "Edit");
        edit.addEventListener("click", () => pmOpenEditor(post));
        row.append(edit);

        list.append(row);
    });
}

/* Post Editor */

function pmToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function pmSlug(date, header) {
    const slug = header.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return `${date}-${slug}`.slice(0, 64).replace(/-+$/, "");
}

// "2026-01-03" -> "3rd of January 2026", matching what pd_posts.php sends the public page.
function pmFormatDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
    if (!match) return value || "";

    const day = Number(match[3]);
    const suffix = (day % 100 >= 11 && day % 100 <= 13) ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[day % 10] || "th");
    const month = new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleString("en-GB", { month: "long" });
    return `${day}${suffix} of ${month} ${match[1]}`;
}

function pmOpenEditor(post) {
    pm.isNew = !post;
    pm.keyTouched = !pm.isNew;
    pm.draft = post
        ? JSON.parse(JSON.stringify(post))
        : {
            postKey: "",
            postHeader: "",
            postDate: pmToday(),
            postSignature: pm.displayName,
            irrelevant: false,
            hidden: true, // new posts start as drafts
            postBody: [{ type: "paragraph", content: "" }]
        };

    document.getElementById("pm-editor-title").textContent = pm.isNew ? "New Post" : "Edit Post";
    document.getElementById("pm-header").value = pm.draft.postHeader;
    document.getElementById("pm-date").value = pm.draft.postDate;
    document.getElementById("pm-signature").value = pm.draft.postSignature;
    document.getElementById("pm-key").value = pm.draft.postKey;
    document.getElementById("pm-key").disabled = !pm.isNew; // the key identifies the post, so it's fixed once created
    document.getElementById("pm-hidden").checked = pm.draft.hidden;
    document.getElementById("pm-irrelevant").checked = pm.draft.irrelevant;
    document.getElementById("pm-delete").style.display = (!pm.isNew && pmCan("news.delete")) ? "" : "none";

    pmRenderBlocks(document.getElementById("pm-blocks"), pm.draft.postBody, PM_EDITOR);
    pmRenderPreview();
    pmStatus("");

    const editor = document.getElementById("pm-editor");
    editor.style.display = "";
    editor.scrollIntoView({ behavior: "smooth", block: "start" });
}

function pmCloseEditor() {
    pm.draft = null;
    document.getElementById("pm-editor").style.display = "none";
}

function pmSyncKey() {
    if (pm.isNew && !pm.keyTouched) {
        pm.draft.postKey = pmSlug(pm.draft.postDate, pm.draft.postHeader);
        document.getElementById("pm-key").value = pm.draft.postKey;
    }
}

function pmAddBlock(type) {
    pm.draft.postBody.push(pmNewBlock(type));
    pmRenderBlocks(document.getElementById("pm-blocks"), pm.draft.postBody, PM_EDITOR);
    pmRenderPreview();
}

function pmRenderPreview() {
    clearTimeout(pm.previewTimer);
    const holder = document.getElementById("pm-preview");
    holder.replaceChildren();
    if (!pm.draft) return;

    // Same renderer as the public News page (pd_post_manager.js). Unsaved text is only
    // rendered in your own browser; the server sanitizes it on save, and the editor
    // reloads the stored version so you see exactly what visitors will.
    holder.append(renderPost({
        ...pm.draft,
        postDate: pmFormatDate(pm.draft.postDate),
        postBody: pmPreviewBody(pm.draft.postBody)
    }));
    pmWatchMissing(holder, "pm-status", pmRenderPreviewSoon);
}

// For typing in media paths: wait until the typing stops before redrawing.
function pmRenderPreviewSoon() {
    clearTimeout(pm.previewTimer);
    pm.previewTimer = setTimeout(pmRenderPreview, 600);
}

async function pmSave() {
    const save = document.getElementById("pm-save");
    save.disabled = true;

    try {
        const data = await pmApi(PM_API, { action: pm.isNew ? "create" : "update", post: pm.draft });
        await pmLoadPosts();
        pmOpenEditor(data.post);
        pmStatus("Saved. Reload the page to see it on the News page.");
    } catch (err) {
        pmError(err);
    } finally {
        save.disabled = false;
    }
}

async function pmDelete() {
    if (!confirm(`Permanently delete "${pm.draft.postHeader}"? This cannot be undone. (Tick "Hidden" instead to just take it down.)`)) {
        return;
    }

    try {
        await pmApi(PM_API, { action: "delete", postKey: pm.draft.postKey });
        pmCloseEditor();
        await pmLoadPosts();
        pmStatus("Post deleted.");
    } catch (err) {
        pmError(err);
    }
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("pm-new").addEventListener("click", () => pmOpenEditor(null));
    document.getElementById("pm-cancel").addEventListener("click", pmCloseEditor);
    document.getElementById("pm-save").addEventListener("click", pmSave);
    document.getElementById("pm-delete").addEventListener("click", pmDelete);

    Object.keys(PM_BLOCK_LABELS).forEach(type => {
        document.getElementById(`pm-add-${type}`).addEventListener("click", () => pmAddBlock(type));
    });

    document.getElementById("pm-header").addEventListener("input", (e) => {
        pm.draft.postHeader = e.target.value;
        pmSyncKey();
        pmRenderPreview();
    });
    document.getElementById("pm-date").addEventListener("input", (e) => {
        pm.draft.postDate = e.target.value;
        pmSyncKey();
        pmRenderPreview();
    });
    document.getElementById("pm-signature").addEventListener("input", (e) => {
        pm.draft.postSignature = e.target.value;
        pmRenderPreview();
    });
    document.getElementById("pm-key").addEventListener("input", (e) => {
        pm.keyTouched = true;
        pm.draft.postKey = e.target.value.trim();
    });
    document.getElementById("pm-hidden").addEventListener("change", (e) => {
        pm.draft.hidden = e.target.checked;
    });
    document.getElementById("pm-irrelevant").addEventListener("change", (e) => {
        pm.draft.irrelevant = e.target.checked;
        pmRenderPreview();
    });

    // pd_discordauth.js announces the login state; catch it even if it already fired.
    if (window.pdAuth) pmOnAuth(window.pdAuth);
    document.addEventListener("pd:auth", (e) => pmOnAuth(e.detail));
});

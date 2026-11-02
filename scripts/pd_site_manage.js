/* Management - Site Manager */

// The main page's titles, descriptions and embed banner (site.manage, Managers and up). An empty
// field uses pd_main.html's own text, shown greyed out in it. Cosmetic like the rest of
// management: php/pd_site_admin.php enforces it, and php/pd_site_meta.php puts it on the page.
// Builds on pd_manage.js.

const ST_API = "/php/pd_site_admin";
const ST_LIVE_URL = "https://www.paddysdreamland.com/"; // PD_SITE_META_URL in pd_site_meta.php
const ST_LATEST_NEWS = /\{latest news\}/gi;             // PD_SITE_META_LATEST_NEWS

// Draft key => its input.
const ST_FIELDS = {
    title: "st-title",
    description: "st-description",
    embedTitle: "st-embed-title",
    embedDescription: "st-embed-description",
    banner: "st-banner"
};

const st = {
    saved: {},       // as stored; "" is pd_main.html's own
    defaults: {},    // pd_main.html's own
    draft: {},
    latestNews: null, // the newest news post's header, for {latest news}
    banners: [],      // the pictures in the main site's images/embeds folder
    previewTimer: 0
};

/* Auth */

function stOnAuth(data) {
    const permissions = (data && data.authenticated && data.permissions) || [];
    if (permissions.includes("site.manage")) stLoad();
}

/* Editor */

async function stLoad() {
    try {
        stApply(await pmApi(ST_API));
    } catch (err) {
        pmError(err, "st-status");
    }
}

// Take the server's state (loaded, or just saved) and start editing it afresh.
function stApply(data) {
    st.saved = data.values;
    st.defaults = data.defaults;
    st.latestNews = data.latestNews;
    st.banners = data.banners || [];
    stRevert();
}

function stRevert() {
    st.draft = { ...st.saved };
    Object.entries(ST_FIELDS).forEach(([key, id]) => {
        const input = document.getElementById(id);
        input.value = st.draft[key] || "";
        input.placeholder = st.defaults[key] || "";
    });

    const pick = document.getElementById("st-banner-pick");
    const prompt = pmEl("option", "", "Pick one from images/embeds…");
    prompt.value = "";
    pick.replaceChildren(prompt);
    st.banners.forEach(src => {
        const option = pmEl("option", "", src.replace(/^images\/embeds\//, ""));
        option.value = src;
        pick.append(option);
    });

    document.getElementById("st-latest-news").textContent = st.latestNews !== null
        ? `"${st.latestNews}"`
        : "none, so the page's own title shows";

    stRenderPreview();
}

// What a field shows on the page, like pd_site_meta_shown() in pd_site_meta.php.
function stShown(key) {
    const value = (st.draft[key] || "").replace(/\s+/g, " ").trim();
    const needsNews = value.search(ST_LATEST_NEWS) !== -1;
    if (value === "" || (needsNews && st.latestNews === null)) return st.defaults[key] || "";
    return value.replace(ST_LATEST_NEWS, () => st.latestNews);
}

// The banner's full address, or "" while it's not a picture path (or one known to be missing).
function stBannerUrl() {
    const src = stShown("banner").replace(/^\/+/, "");
    const url = ST_LIVE_URL + src;
    return pmValidPath(src, "png|jpe?g|gif|webp") && !pm.missingPaths.has(url) ? url : "";
}

/* Preview */

function stRenderPreview() {
    clearTimeout(st.previewTimer);
    const holder = document.getElementById("st-preview");
    holder.replaceChildren();

    // A link to the site shared on Discord.
    const embed = pmEl("div", "st-embed");
    embed.append(
        pmEl("div", "st-embed-site", "Paddy's Dreamland™"),
        pmEl("div", "st-embed-title", stShown("embedTitle")),
        pmEl("div", "st-embed-description", stShown("embedDescription"))
    );
    const banner = stBannerUrl();
    if (banner) {
        const image = pmEl("img", "st-embed-image");
        image.src = banner;
        image.alt = "";
        embed.append(image);
    }

    // The site in search results, which cut long titles and descriptions short like this.
    const result = pmEl("div", "st-search");
    result.append(
        pmEl("div", "st-search-url", "paddysdreamland.com"),
        pmEl("div", "st-search-title", stShown("title")),
        pmEl("div", "st-search-description", stShown("description"))
    );

    holder.append(
        pmEl("div", "setting-label", "Shared on Discord"), embed,
        pmEl("div", "horizontal-break"),
        pmEl("div", "setting-label", "In search results"), result
    );
    pmWatchMissing(holder, "st-status", stRenderPreviewSoon);
}

// For typing in a banner path: wait until the typing stops before redrawing.
function stRenderPreviewSoon() {
    clearTimeout(st.previewTimer);
    st.previewTimer = setTimeout(stRenderPreview, 600);
}

/* Saving */

async function stUploadBanner(file) {
    const button = document.getElementById("st-banner-upload");
    button.disabled = true;

    try {
        pmStatus("Uploading…", "", "st-status");
        st.draft.banner = await pmUploadImage(file, { site: "live" });
        document.getElementById("st-banner").value = st.draft.banner;
        stRenderPreview();
        pmStatus("Uploaded to the main site. Remember to save.", "", "st-status");
    } catch (err) {
        pmError(err, "st-status");
    } finally {
        button.disabled = false;
    }
}

async function stSave() {
    const save = document.getElementById("st-save");
    save.disabled = true;

    try {
        stApply(await pmApi(ST_API, { action: "update", values: st.draft }));
        pmStatus("Saved. The page has it from the next visit; Discord and other sites can take a while to drop the copy of the old embed they keep.", "", "st-status");
    } catch (err) {
        pmError(err, "st-status");
    } finally {
        save.disabled = false;
    }
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    Object.entries(ST_FIELDS).forEach(([key, id]) => {
        document.getElementById(id).addEventListener("input", (e) => {
            st.draft[key] = e.target.value;
            key === "banner" ? stRenderPreviewSoon() : stRenderPreview();
        });
    });

    const pick = document.getElementById("st-banner-pick");
    pick.addEventListener("change", () => {
        if (!pick.value) return;
        st.draft.banner = pick.value;
        document.getElementById("st-banner").value = pick.value;
        pick.value = "";
        stRenderPreview();
    });

    const picker = document.getElementById("st-banner-file");
    document.getElementById("st-banner-upload").addEventListener("click", () => picker.click());
    picker.addEventListener("change", () => {
        const file = picker.files[0];
        picker.value = "";
        if (file) stUploadBanner(file);
    });

    document.getElementById("st-revert").addEventListener("click", () => {
        stRevert();
        pmStatus("", "", "st-status");
    });
    document.getElementById("st-save").addEventListener("click", stSave);

    // pd_discordauth.js announces the login state; catch it even if it already fired.
    if (window.pdAuth) stOnAuth(window.pdAuth);
    document.addEventListener("pd:auth", (e) => stOnAuth(e.detail));
});

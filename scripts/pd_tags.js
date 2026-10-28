/* Timezone */

// php/pd_tags.php reads times like "18:00" in the visitor's own timezone, which only the
// browser knows. Remember it in the pd_tz cookie for the server. A page with timed content
// says which timezone it was made for (Berlin, before the cookie existed); if that's not ours,
// reload once to get the page as it should be here. Behind the loading screen, that's quick.

function rememberTimeZone() {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return;

    const cookie = `pd_tz=${encodeURIComponent(zone)}`;
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${cookie}; path=/; max-age=31536000; SameSite=Lax${secure}`;

    const madeFor = document.querySelector('meta[name="pd-tags-zone"]');
    if (!madeFor || madeFor.content === zone) return;

    // Without the cookie (blocked), or if the server doesn't know this timezone, a reload
    // would come back the same, so only ever try once per visit.
    if (!document.cookie.split("; ").includes(cookie)) return;
    try {
        if (sessionStorage.getItem("pdTagsZoneReload") === zone) return;
        sessionStorage.setItem("pdTagsZoneReload", zone);
    } catch (err) {
        return;
    }
    window.location.reload();
}

rememberTimeZone();

/* Temporary Content */

// Content that ends while the page is open is a <pd-temporary> with data-ends-at, this browser's
// time (ms) to remove it at. A shown <temporary until="…"> arrives from php/pd_tags.php with
// data-ends-in instead, in seconds from when the page was made, and gets its data-ends-at here;
// renderBlocks() gives conditional blocks theirs when news posts and About Us blocks arrive.
// Counting from when it arrived (not a date) means a computer clock that's off doesn't matter.
// Checked every few seconds instead of one long timer, because timers stop while a computer sleeps.

const temporaryLoadedAt = Date.now();

function removeEndedTemporaries() {
    document.querySelectorAll("pd-temporary[data-ends-at]").forEach(element => {
        if (Date.now() >= Number(element.dataset.endsAt)) element.remove();
    });
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("pd-temporary[data-ends-in]").forEach(element => {
        element.dataset.endsAt = temporaryLoadedAt + Number(element.dataset.endsIn) * 1000;
    });

    removeEndedTemporaries();
    setInterval(removeEndedTemporaries, 10000);
});

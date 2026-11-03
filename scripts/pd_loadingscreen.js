window.addEventListener("load", function () {
    const loadingHolder = document.getElementById("loading-holder");
    const loadingIcon = this.document.getElementById("loading-icon");

    loadingHolder.classList = "loading-holder-fade";
    loadingIcon.remove();

    loadingHolder.addEventListener("animationend", () => {
        loadingHolder.remove();
    });

    // Iframes with a data-src (like the Twitch player) only start now: the load event waits for
    // everything inside an iframe too, which would keep the loading screen up for that long.
    document.querySelectorAll("iframe[data-src]").forEach(iframe => {
        iframe.src = iframe.dataset.src;
    });
});
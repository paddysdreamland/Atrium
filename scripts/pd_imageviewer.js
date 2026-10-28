/* Image Viewer */

// Full-screen viewer for gallery blocks. Call openImageViewer(images, index) with
// images as [{ src, caption? }]; the strip at the bottom lists every image passed in.
// A picture shown smaller than its real size zooms to full size when clicked, and can then
// be dragged around. On touch screens, swiping sideways goes to the previous or next one.

const iv = {
    images: [],
    index: 0,
    returnFocus: null, // what had focus before opening, so closing can give it back
    pointer: null      // the press in progress on the stage: a click, a drag or a swipe
};

const IV_SWIPE_DISTANCE = 50; // px sideways before a touch counts as a swipe
const IV_CLICK_SLOP = 5;      // px a click may wobble before it counts as a drag

function openImageViewer(images, index) {
    if (!images || images.length === 0) return;

    iv.images = images;
    iv.returnFocus = document.activeElement;

    const nav = document.getElementById("iv-nav");
    nav.replaceChildren();
    images.forEach((image, i) => {
        const thumb = document.createElement("button");
        thumb.className = "iv-nav-image";
        thumb.title = image.caption || `Image ${i + 1}`;
        // JSON.stringify quotes and escapes the path, so it can't break out of url("...").
        thumb.style.backgroundImage = `url(${JSON.stringify(image.src)})`;
        thumb.addEventListener("click", () => showViewerImage(i));
        nav.appendChild(thumb);
    });

    const holder = document.getElementById("iv-holder");
    holder.classList.toggle("iv-single", images.length < 2);
    holder.classList.add("iv-open");
    // The page behind can't be clicked or tabbed into while the viewer is open.
    document.getElementById("website-holder").inert = true;

    showViewerImage(index || 0);
    document.getElementById("iv-close").focus();
}

function closeImageViewer() {
    if (!isImageViewerOpen()) return;

    setViewerZoom(false);
    document.getElementById("iv-holder").classList.remove("iv-open");
    document.getElementById("website-holder").inert = false;
    if (iv.returnFocus) iv.returnFocus.focus();
}

function isImageViewerOpen() {
    return document.getElementById("iv-holder").classList.contains("iv-open");
}

function showViewerImage(index) {
    const count = iv.images.length;
    iv.index = (index + count) % count; // wrap around at both ends
    const image = iv.images[iv.index];

    setViewerZoom(false);

    const stage = document.getElementById("iv-stage");
    const img = document.getElementById("iv-image");
    if (img.getAttribute("src") !== image.src) {
        // Hidden until it has loaded (see Init), then faded in.
        stage.classList.remove("iv-error");
        stage.classList.add("iv-loading");
        document.getElementById("iv-holder").classList.remove("iv-zoomable");
        img.src = image.src;
    } else {
        updateViewerZoomable(); // same picture, but the window may have changed size since
    }
    img.alt = image.caption || "";

    document.getElementById("iv-backdrop").style.backgroundImage = `url(${JSON.stringify(image.src)})`;
    document.getElementById("iv-caption").textContent = image.caption || "";

    const current = document.createElement("span");
    current.className = "iv-counter-current";
    current.textContent = iv.index + 1;
    document.getElementById("iv-counter").replaceChildren(current, ` / ${count}`);

    // Only ever link out to http(s), never e.g. a javascript: URL from bad data.
    const url = new URL(image.src, window.location.href);
    document.getElementById("iv-original").href = (url.protocol === "https:" || url.protocol === "http:") ? url.href : "#";

    document.querySelectorAll("#iv-nav .iv-nav-image").forEach((thumb, i) => {
        const active = i === iv.index;
        thumb.classList.toggle("iv-nav-image-active", active);
        if (active) thumb.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    });

    // Fetch the neighbours now, so paging through doesn't wait on the network.
    if (count > 1) {
        new Image().src = iv.images[(iv.index + 1) % count].src;
        new Image().src = iv.images[(iv.index - 1 + count) % count].src;
    }
}

/* Zoom */

// A picture shown smaller than its real size can be zoomed in.
function updateViewerZoomable() {
    const holder = document.getElementById("iv-holder");
    if (holder.classList.contains("iv-zoomed")) return; // at full size there's nothing to compare

    const img = document.getElementById("iv-image");
    const zoomable = img.complete && img.naturalWidth > 0 &&
        (img.naturalWidth > img.clientWidth + 1 || img.naturalHeight > img.clientHeight + 1);
    holder.classList.toggle("iv-zoomable", zoomable);
}

// Zoom to the picture's real size, or back to fitting the screen. Zooming in on a click keeps
// the clicked spot under the cursor; without one, the middle of the picture stays put.
function setViewerZoom(zoomed, clientX, clientY) {
    const holder = document.getElementById("iv-holder");
    if (zoomed === holder.classList.contains("iv-zoomed")) return;
    if (zoomed && !holder.classList.contains("iv-zoomable")) return;

    const stage = document.getElementById("iv-stage");
    const img = document.getElementById("iv-image");
    const imageBox = img.getBoundingClientRect();
    const stageBox = stage.getBoundingClientRect();
    const x = clientX ?? imageBox.left + imageBox.width / 2;
    const y = clientY ?? imageBox.top + imageBox.height / 2;
    // The spot as a fraction of the picture, measured before it changes size.
    const fx = Math.min(Math.max((x - imageBox.left) / imageBox.width, 0), 1);
    const fy = Math.min(Math.max((y - imageBox.top) / imageBox.height, 0), 1);

    holder.classList.toggle("iv-zoomed", zoomed);
    document.getElementById("iv-zoom").title = zoomed ? "Zoom out" : "Zoom in";

    if (zoomed) {
        stage.scrollLeft = img.offsetLeft + fx * img.offsetWidth - (x - stageBox.left);
        stage.scrollTop = img.offsetTop + fy * img.offsetHeight - (y - stageBox.top);
    } else {
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
    }
}

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    const holder = document.getElementById("iv-holder");
    const stage = document.getElementById("iv-stage");
    const img = document.getElementById("iv-image");

    document.getElementById("iv-close").addEventListener("click", closeImageViewer);
    document.getElementById("iv-prev").addEventListener("click", () => showViewerImage(iv.index - 1));
    document.getElementById("iv-next").addEventListener("click", () => showViewerImage(iv.index + 1));
    document.getElementById("iv-zoom").addEventListener("click", () => setViewerZoom(!holder.classList.contains("iv-zoomed")));

    img.addEventListener("load", () => {
        stage.classList.remove("iv-loading");
        updateViewerZoomable();
    });
    img.addEventListener("error", () => {
        stage.classList.remove("iv-loading");
        stage.classList.add("iv-error");
    });

    // Clicking the empty bars around the picture closes the viewer (the stage handles its own).
    holder.addEventListener("click", (event) => {
        if (event.target === holder || event.target.classList.contains("iv-bar")) closeImageViewer();
    });

    // One press on the stage is a click (zoom, or close on the empty space around the picture),
    // a mouse drag (pans a zoomed picture) or a touch swipe (previous / next).
    stage.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        iv.pointer = {
            id: event.pointerId,
            type: event.pointerType,
            target: event.target,
            x: event.clientX,
            y: event.clientY,
            scrollLeft: stage.scrollLeft,
            scrollTop: stage.scrollTop,
            moved: false
        };
        if (event.pointerType === "mouse") stage.setPointerCapture(event.pointerId);
    });

    stage.addEventListener("pointermove", (event) => {
        const press = iv.pointer;
        if (!press || press.id !== event.pointerId) return;

        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        if (Math.abs(dx) > IV_CLICK_SLOP || Math.abs(dy) > IV_CLICK_SLOP) press.moved = true;

        // Touch screens scroll a zoomed picture by themselves.
        if (press.moved && press.type === "mouse" && holder.classList.contains("iv-zoomed")) {
            holder.classList.add("iv-dragging");
            stage.scrollLeft = press.scrollLeft - dx;
            stage.scrollTop = press.scrollTop - dy;
        }
    });

    stage.addEventListener("pointerup", (event) => {
        const press = iv.pointer;
        if (!press || press.id !== event.pointerId) return;
        iv.pointer = null;
        holder.classList.remove("iv-dragging");

        const dx = event.clientX - press.x;
        const dy = event.clientY - press.y;
        const zoomed = holder.classList.contains("iv-zoomed");

        if (!press.moved) {
            if (press.target === img) setViewerZoom(!zoomed, event.clientX, event.clientY);
            else if (zoomed) setViewerZoom(false);
            else closeImageViewer();
        } else if (press.type !== "mouse" && !zoomed && Math.abs(dx) > IV_SWIPE_DISTANCE && Math.abs(dx) > Math.abs(dy)) {
            showViewerImage(iv.index + (dx < 0 ? 1 : -1));
        }
    });

    stage.addEventListener("pointercancel", () => {
        iv.pointer = null;
        holder.classList.remove("iv-dragging");
    });

    window.addEventListener("resize", () => {
        if (isImageViewerOpen()) updateViewerZoomable();
    });

    document.addEventListener("keydown", (event) => {
        if (!isImageViewerOpen()) return;
        if (event.key === "Escape") closeImageViewer();
        else if (event.key === "ArrowLeft") showViewerImage(iv.index - 1);
        else if (event.key === "ArrowRight") showViewerImage(iv.index + 1);
        else if (event.key === "Home") showViewerImage(0);
        else if (event.key === "End") showViewerImage(iv.images.length - 1);
        else return;
        event.preventDefault();
    });
});

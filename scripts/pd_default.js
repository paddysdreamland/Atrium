/* Default */

document.addEventListener('wheel', function (event) {
    if (event.ctrlKey === true) {
        event.preventDefault();
    }
}, { passive: false });

document.addEventListener('keydown', function (event) {
    if (event.ctrlKey === true && (event.key === '+' || event.key === '-' || event.key === '0')) {
        event.preventDefault();
    }
});

function detectZoom() {
    if (window.devicePixelRatio !== 1) {
        let warning = document.getElementById('zoom-warning');
        if (!warning) {
            warning = document.createElement('div');
            warning.id = 'zoom-warning';
            warning.style.position = 'fixed';
            warning.style.bottom = '10px';
            warning.style.right = '10px';
            warning.style.background = 'rgba(0, 0, 0, 0.75)';
            warning.style.color = 'white';
            warning.style.fontFamily = 'Lato';
            warning.style.padding = '10px 20px';
            warning.style.borderRadius = '5px';
            warning.style.zIndex = '9999';
            warning.innerText = 'I would highly discourage you from zooming.';
            document.body.appendChild(warning);

            setTimeout(() => {
                warning.remove();
            }, 5000); // Auto-remove after 5 seconds
        }
    }
}

/* Local Storage */

function openLastSection() {
    var lastVisitedSection = localStorage.getItem("lastVisitedSection");
    // Fall back to "home" if nothing was stored or the stored section no longer exists.
    if (lastVisitedSection && document.getElementById(lastVisitedSection + "-section")) {
        openSection(lastVisitedSection);
    } else {
        openSection("home");
    }
}

/* Navigation - Main */

var pdSections = document.querySelectorAll("section");

function closeAllSections() {
    pdSections.forEach(function (section) {
        section.style.display = "none";
    });
}

// Show a single section by name. A "name" maps to the element id "<name>-section".
// No-op if that section doesn't exist, so callers never need to check first.
function openSection(name) {
    var section = document.getElementById(name + "-section");
    if (!section) {
        return;
    }
    closeAllSections();
    section.style.display = "block";
    localStorage.setItem("lastVisitedSection", name);
}

// Wire up navigation by convention: every "<name>-button" that has a matching
// "<name>-section" becomes a nav button automatically. Buttons without a section
// (e.g. social links) are skipped. Add a new section by adding the matching
// "credits-button" + "credits-section" elements — no JS changes required.
document.querySelectorAll('[id$="-button"]').forEach(function (button) {
    var name = button.id.slice(0, -"-button".length);
    if (!document.getElementById(name + "-section")) {
        return;
    }
    button.addEventListener("click", function () {
        if (button.querySelector(".nav-locked")) {
            console.log("This section is locked.");
            return;
        }
        openSection(name);
    });
});

/* Navigation - Socials */

var socialLinks = {
    "discord-button": "https://discord.gg/paddysdreamland",
    "twitch-button": "https://www.twitch.tv/paddysdreamland/about",
    "youtube-button": "https://www.youtube.com/@paddysdreamland",
    "github-button": "https://github.com/paddysdreamland/Website",
    "glg-button": "/glassguessr.html",
    "staging-button": "https://staging.paddysdreamland.com"
};

Object.keys(socialLinks).forEach(function (id) {
    var button = document.getElementById(id);

    if (!button) {
        return;
    }

    button.addEventListener("click", function () {
        window.open(socialLinks[id]);
    });
});

/* Media */

function playSound(soundPath, soundVolume = 1) {
    if (!soundPath) {
        console.warn("Sound file not found or invalid.");
        return;
    }

    var newSound = new Audio(soundPath);
    newSound.volume = soundVolume;
    newSound.play();
}

document.querySelectorAll('button').forEach(function (button) {
    button.addEventListener('click', function () {
        playSound("ME_Sound/UI/ME_ProgressionTree_Nav.wav", 0.125)
    });

    button.addEventListener('mouseenter', function () {
        //playSound("sounds/ui/buttonrollover.wav", 1)
    });
});

document.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
        playSound("ME_Sound/UI/ME_ProgressionTree_Nav.wav", 0.125)
    });

    a.addEventListener('mouseenter', function () {
        //playSound("sounds/ui/buttonrollover.wav", 1)
    });
});

/* Sections */

const loreText = document.getElementById("lore-continuation");
const loreButton = document.getElementById("lore-button");

loreButton.addEventListener("click", function() {
    loreText.style.display = "flex";
    loreButton.style.display = "none";
});

/* Init */

document.addEventListener("DOMContentLoaded", function () {
    openLastSection();
});
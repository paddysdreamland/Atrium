document.addEventListener("DOMContentLoaded", function () {
    const subtitles = [
        // Paddy-V
        `Some people like to call this place an atrium, which makes sense considering its nature.`,
        `You can be discoverable and miserable, or obscure and authentic.`,
        `Welcome to the inner workings of my mind.`,
    ];

    const subHour = new Date().getUTCHours();
    const subIndex = subHour % subtitles.length;

    const dynamicSubtitle = document.getElementById("dynamic-subtitle");
    dynamicSubtitle.innerHTML = `"${subtitles[subIndex]}"`;

    //---

    /*const sectionContainers = document.querySelectorAll(".section-container");

    sectionContainers.forEach((container, index) => {
        const previousSibling = container.previousElementSibling;
    
        if (previousSibling && previousSibling.classList.contains("section-container")) {
            const divider = document.createElement("div");
            divider.classList.add("section-rule");
            container.parentNode.insertBefore(divider, container);
        }
    });*/
    
    //---

    const sections = document.querySelectorAll('section');
    sections.forEach(section => {
        const sectionEndHolder = document.createElement('div');
        sectionEndHolder.className = 'section-end-holder';
        sectionEndHolder.innerHTML = `
        <div class="silk-error"></div>
        <div class="section-end-text">END OF SECTION</div>
        <div class="silk-error"></div>
        `;
        section.appendChild(sectionEndHolder);
    });

    //---

    const themeMetaTag = document.querySelector('meta[name="theme-color"]');
    
    if (themeMetaTag) {
        themeMetaTag.setAttribute("content", "#000000");
    }

    //---

    const lastUpdateElement = document.getElementById('last-update');
    if (lastUpdateElement) {
        const lastModifiedDate = new Date(document.lastModified);
        const day = lastModifiedDate.getDate();
        const month = lastModifiedDate.toLocaleString('en-US', { month: 'long' });
        const year = lastModifiedDate.getFullYear();

        const daySuffix = (day) => {
            if (day > 3 && day < 21) return 'th';
            switch (day % 10) {
                case 1: return 'st';
                case 2: return 'nd';
                case 3: return 'rd';
                default: return 'th';
            }
        };

        const timeAgo = () => {
            const now = new Date();
            const diffInSeconds = Math.floor((now - lastModifiedDate) / 1000);

            if (diffInSeconds < 60) {
                return `${diffInSeconds} seconds ago`;
            } else if (diffInSeconds < 3600) {
                const minutes = Math.floor(diffInSeconds / 60);
                return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
            } else if (diffInSeconds < 86400) {
                const hours = Math.floor(diffInSeconds / 3600);
                return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
            } else if (diffInSeconds < 2592000) {
                const days = Math.floor(diffInSeconds / 86400);
                return `${days} ${days === 1 ? 'day' : 'days'} ago`;
            } else if (diffInSeconds < 31536000) {
                const months = Math.floor(diffInSeconds / 2592000);
                return `${months} ${months === 1 ? 'month' : 'months'} ago`;
            } else {
                const years = Math.floor(diffInSeconds / 31536000);
                return `${years} ${years === 1 ? 'year' : 'years'} ago`;
            }
        };

        lastUpdateElement.textContent = `Last updated: ${day}${daySuffix(day)} of ${month} ${year} (${timeAgo()})`;

        setInterval(() => {
            lastUpdateElement.textContent = `Last updated: ${day}${daySuffix(day)} of ${month} ${year} (${timeAgo()})`;
        }, 1000);
    }
});
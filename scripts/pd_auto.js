document.addEventListener("DOMContentLoaded", function () {
    const subtitles = [
        // Paddy-V
        `Some people like to call this place an atrium, which makes sense considering its nature.`,

        // ChatGPT
        `You can be discoverable and miserable, or obscure and authentic.`,
        
        // Low Roar
        `The dream controls my attitude, tells me what to say and to do.`,
        `You're a part of me, and I'm a part of you.`,
        
        // Muse
        `How can we win when fools can be kings?`,
        `Don't waste your time, or time will waste you.`,

        // Mystery Skulls
        `I'm not freaking out, but it feels like time is running out.`,
        `I need to stop worrying about the things I can't control.`,
        `I used to worry every day, now I got better things.`,
        `I can't fight this feeling, it's not in my head.`,
        `This time I might just disappear.`,

        // Tame Impala
        `If only there could be another way to do this.`,

        // Vylet Pony
        `Just imagine what it's like to be like me, live like me.`,
        `I can't remember anymore, maybe I buried the key?`,
        `Isn't it great to be exactly who you are?`,

        // The Weeknd
        `Scared? Don't worry, we'll be there to hold your hand.`,
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